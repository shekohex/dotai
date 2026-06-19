import type { BackgroundShellRun } from "./background-bash-types.js";

export type BackgroundBackendName = "herdr" | "pty" | "tmux";

export type BackgroundLaunchInput = {
  command: string;
  cwd: string;
  description: string;
  exitFile: string;
  id: string;
  label: string;
  outputFile: string;
  pollIntervalMs?: number;
  scriptPath: string;
  startedAt: number;
};

export type BackgroundLaunchResult = {
  backend: BackgroundBackendName;
  muxSession?: string;
  targetId: string;
  targetLabel: string;
};

export interface BackgroundShellBackend {
  readonly name: BackgroundBackendName;
  isAvailable(cwd: string): Promise<boolean>;
  launch(input: BackgroundLaunchInput): Promise<BackgroundLaunchResult>;
  targetExists(run: BackgroundShellRun): Promise<boolean>;
  kill(run: BackgroundShellRun): Promise<void>;
  formatInspectHint(run: BackgroundShellRun): string;
  formatPeekHint(run: BackgroundShellRun): string;
  formatKillHint(run: BackgroundShellRun): string;
}
