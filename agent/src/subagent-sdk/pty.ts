import { SerializeAddon } from "@xterm/addon-serialize";
import headless from "@xterm/headless";
import type { Terminal as XtermTerminal } from "@xterm/headless";
import { spawn, type IPty } from "zigpty";
import type { CreatePaneOptions, MuxAdapter, PaneCapture, PaneSubmitMode } from "./mux.js";

const { Terminal } = headless;

const DEFAULT_COLUMNS = 120;
const DEFAULT_ROWS = 40;
const SUBMIT_KEYS: Record<PaneSubmitMode, string> = {
  steer: "\r",
  followUp: "\u001B\r",
};

type PtyPane = {
  pty: IPty;
  terminal: XtermTerminal;
  serializeAddon: SerializeAddon;
  writeChain: Promise<void>;
};

function createPaneId(pid: number): string {
  return `pty:${pid}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

function createShellCommand(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return { file: "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  const configuredShell = process.env.SHELL?.trim();
  return {
    file: configuredShell !== undefined && configuredShell.length > 0 ? configuredShell : "/bin/sh",
    args: ["-lc", command],
  };
}

function getProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

function serializePlainText(terminal: XtermTerminal, lines: number): string {
  const buffer = terminal.buffer.active;
  const output: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    const line = buffer.getLine(index)?.translateToString(true) ?? "";
    output.push(line);
  }
  while (output.length > 0 && output[0]?.length === 0) {
    output.shift();
  }
  while (output.length > 0 && output.at(-1)?.length === 0) {
    output.pop();
  }
  return `${output
    .slice(Math.max(0, output.length - lines))
    .join("\n")
    .trimEnd()}\n`;
}

export class PtyAdapter implements MuxAdapter {
  readonly backend = "pty";
  private readonly panes = new Map<string, PtyPane>();

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  createPane(options: CreatePaneOptions): Promise<{ paneId: string; backend: string }> {
    const terminal = new Terminal({
      allowProposedApi: true,
      cols: DEFAULT_COLUMNS,
      rows: DEFAULT_ROWS,
      scrollback: 5000,
    });
    const serializeAddon = new SerializeAddon();
    terminal.loadAddon(serializeAddon);
    const shellCommand = createShellCommand(options.command);
    let pty: IPty;
    try {
      pty = spawn(shellCommand.file, shellCommand.args, {
        cwd: options.cwd,
        cols: DEFAULT_COLUMNS,
        rows: DEFAULT_ROWS,
        name: "xterm-256color",
        env: getProcessEnv(),
      });
    } catch (error) {
      terminal.dispose();
      serializeAddon.dispose();
      throw error;
    }
    const paneId = createPaneId(pty.pid);
    const pane: PtyPane = { pty, terminal, serializeAddon, writeChain: Promise.resolve() };
    pty.onData((data) => {
      pane.writeChain = pane.writeChain.then(
        () =>
          new Promise<void>((resolve) => {
            terminal.write(typeof data === "string" ? data : new Uint8Array(data), resolve);
          }),
      );
    });
    this.panes.set(paneId, pane);
    return Promise.resolve({ paneId, backend: this.backend });
  }

  sendText(paneId: string, text: string, submitMode: PaneSubmitMode = "steer"): Promise<void> {
    const pane = this.getPane(paneId);
    pane.pty.write(`\u001B[200~${text}\u001B[201~${SUBMIT_KEYS[submitMode]}`);
    return Promise.resolve();
  }

  paneExists(paneId: string): Promise<boolean> {
    const pane = this.panes.get(paneId);
    return Promise.resolve(pane !== undefined && pane.pty.exitCode === null);
  }

  killPane(paneId: string): Promise<void> {
    const pane = this.panes.get(paneId);
    if (pane === undefined) {
      return Promise.resolve();
    }
    try {
      pane.pty.kill();
    } catch {}
    try {
      pane.pty.close();
    } catch {}
    this.panes.delete(paneId);
    pane.terminal.dispose();
    pane.serializeAddon.dispose();
    return Promise.resolve();
  }

  async capturePane(paneId: string, lines = 120): Promise<PaneCapture> {
    const pane = this.getPane(paneId);
    await pane.writeChain;
    return { text: serializePlainText(pane.terminal, lines) };
  }

  private getPane(paneId: string): PtyPane {
    const pane = this.panes.get(paneId);
    if (pane === undefined) {
      throw new Error(`pty pane not found: ${paneId}`);
    }
    return pane;
  }

  dispose(): void {
    for (const paneId of Array.from(this.panes.keys())) {
      void this.killPane(paneId);
    }
  }
}
