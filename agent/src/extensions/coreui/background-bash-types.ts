import type { BashToolDetails } from "@earendil-works/pi-coding-agent";

export const BACKGROUND_SHELL_WIDGET_KEY = "coreui-background-shells";
export const BACKGROUND_SHELL_COMPLETION_MESSAGE = "background-bash-completion";
export const BACKGROUND_SHELL_POLL_MESSAGE = "background-bash-poll";

export type BackgroundShellStatus = "running" | "completed" | "failed" | "killed" | "missing";

export type BackgroundBashToolDetails = BashToolDetails & {
  background?: true;
  backend?: "herdr" | "pty" | "tmux";
  command?: string;
  cwd?: string;
  description?: string;
  exitFile?: string;
  id?: string;
  muxSession?: string;
  outputFile?: string;
  pollIntervalMs?: number;
  startedAt?: number;
  status?: BackgroundShellStatus;
  targetId?: string;
  targetLabel?: string;
};

export type BackgroundShellRun = Required<
  Pick<
    BackgroundBashToolDetails,
    "command" | "cwd" | "exitFile" | "id" | "outputFile" | "startedAt"
  >
> & {
  backend: "herdr" | "pty" | "tmux";
  completedAt?: number;
  description?: string;
  exitCode?: number;
  muxSession?: string;
  pollIntervalMs?: number;
  status: BackgroundShellStatus;
  targetId: string;
  targetLabel: string;
};

export type BackgroundShellMessageDetails = {
  command?: string;
  description?: string;
  exitCode?: number | string;
  outputFile?: string;
  pollLineCount?: number;
  pollOmittedLineCount?: number;
  status?: BackgroundShellStatus | "success";
  targetLabel?: string;
};
