import { writeFile } from "node:fs/promises";
import { spawn as spawnPty } from "zigpty";

import type {
  BackgroundLaunchInput,
  BackgroundLaunchResult,
  BackgroundShellBackend,
} from "./background-bash-backend.js";
import type { BackgroundShellRun } from "./background-bash-types.js";

export class PtyBackgroundShellBackend implements BackgroundShellBackend {
  readonly name = "pty" as const;

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  launch(input: BackgroundLaunchInput): Promise<BackgroundLaunchResult> {
    const pty = spawnPty(input.scriptPath, [], {
      cols: 120,
      cwd: input.cwd,
      env: getProcessEnv(),
      name: "xterm-256color",
      rows: 40,
    });
    pty.onExit(({ exitCode }) => {
      void writeFile(input.exitFile, `${exitCode}\n`).catch(() => {});
    });
    return Promise.resolve({
      backend: this.name,
      targetId: `pty:${pty.pid}`,
      targetLabel: `pty ${pty.pid}`,
    });
  }

  targetExists(run: BackgroundShellRun): Promise<boolean> {
    return Promise.resolve(ptyProcessExists(run.targetId));
  }

  kill(run: BackgroundShellRun): Promise<void> {
    killPtyProcess(run.targetId);
    return Promise.resolve();
  }

  formatInspectHint(run: BackgroundShellRun): string {
    return [
      `Peek while running: tail -n 200 ${run.outputFile}`,
      `Stop while running: /background kill ${run.id}`,
      `Output file: ${run.outputFile}`,
    ].join("\n");
  }

  formatPeekHint(run: BackgroundShellRun): string {
    return `peek: tail -n 200 ${run.outputFile}`;
  }

  formatKillHint(run: BackgroundShellRun): string {
    if (run.status !== "running")
      return `kill: unavailable · ${run.status} commands are inspect-only`;
    return `kill: K/x stop · ${run.targetId}`;
  }
}

function getProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function ptyProcessExists(targetId: string): boolean {
  const pid = parsePtyPid(targetId);
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPtyProcess(targetId: string): void {
  const pid = parsePtyPid(targetId);
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
}

function parsePtyPid(targetId: string): number | undefined {
  const pid = Number(targetId.replace(/^pty:/, ""));
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}
