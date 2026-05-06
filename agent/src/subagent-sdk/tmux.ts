import type { ExecOptions, ExecResult } from "@mariozechner/pi-coding-agent";

import type { CreatePaneOptions, MuxAdapter, PaneCapture, PaneSubmitMode } from "./mux.js";

type ExecFunction = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

export class TmuxAdapter implements MuxAdapter {
  readonly backend = "tmux";

  constructor(
    private readonly exec: ExecFunction,
    private readonly cwd: string,
  ) {}

  async isAvailable(): Promise<boolean> {
    if (process.env.TMUX === undefined || process.env.TMUX.length === 0) {
      return false;
    }

    const result = await this.exec("tmux", ["-V"], { cwd: this.cwd });
    return result.code === 0;
  }

  async createPane(options: CreatePaneOptions): Promise<{ paneId: string }> {
    const createArgs =
      options.target === "window"
        ? [
            "new-window",
            "-d",
            "-c",
            options.cwd,
            "-n",
            options.title,
            "-P",
            "-F",
            "#{pane_id}",
            options.command,
          ]
        : [
            "split-window",
            "-d",
            "-h",
            "-c",
            options.cwd,
            "-P",
            "-F",
            "#{pane_id}",
            options.command,
          ];
    const result = await this.exec("tmux", createArgs, { cwd: this.cwd });
    this.assertOk(result, options.target === "window" ? "create window" : "create pane");

    const [paneId] = result.stdout.trim().split("\t");
    if (!paneId) {
      throw new Error("tmux did not return a pane id");
    }

    await this.exec("tmux", ["select-pane", "-t", paneId, "-T", options.title], { cwd: this.cwd });
    return { paneId };
  }

  async sendText(
    paneId: string,
    text: string,
    submitMode: PaneSubmitMode = "steer",
  ): Promise<void> {
    // Use bracketed paste mode so pi's StdinBuffer recognizes the entire
    // content as a single paste, preserving newlines and tabs.
    // Without this, each line pasted via tmux gets split into separate
    // data sequences, making multi-line messages arrive as individual steers.
    // Bracketed paste: \x1b[200~<text>\x1b[201~ then submit key.
    const submitKey = submitMode === "followUp" ? "M-Enter" : "Enter";
    const args: string[] = [
      "send-keys",
      "-t",
      paneId,
      "Escape",
      "-l",
      "[200~",
      "-l",
      text,
      "-l",
      "[201~",
      submitKey,
    ];
    this.assertOk(await this.exec("tmux", args, { cwd: this.cwd }), "send pasted text");
  }

  async paneExists(paneId: string): Promise<boolean> {
    const result = await this.exec("tmux", ["list-panes", "-a", "-F", "#{pane_id}"], {
      cwd: this.cwd,
    });
    if (result.code !== 0) {
      return false;
    }

    return result.stdout
      .split("\n")
      .map((value) => value.trim())
      .includes(paneId);
  }

  async killPane(paneId: string): Promise<void> {
    const result = await this.exec("tmux", ["kill-pane", "-t", paneId], { cwd: this.cwd });
    if (result.code !== 0 && !result.stderr.includes("can't find pane")) {
      this.assertOk(result, "kill pane");
    }
  }

  async capturePane(paneId: string, lines = 120): Promise<PaneCapture> {
    const start = Math.max(0, lines - 1) * -1;
    const result = await this.exec(
      "tmux",
      ["capture-pane", "-p", "-t", paneId, "-S", String(start)],
      { cwd: this.cwd },
    );
    this.assertOk(result, "capture pane");
    return { text: result.stdout };
  }

  private assertOk(result: ExecResult, action: string): void {
    if (result.code === 0) {
      return;
    }

    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    throw new Error(`tmux ${action} failed: ${detail}`);
  }
}
