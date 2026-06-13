import type { BashToolDetails } from "@earendil-works/pi-coding-agent";

export const BACKGROUND_SHELL_WIDGET_KEY = "coreui-background-shells";
export const BACKGROUND_SHELL_COMPLETION_MESSAGE = "tmux-bash-completion";
export const BACKGROUND_SHELL_POLL_MESSAGE = "tmux-bash-poll";

export type BackgroundShellStatus = "running" | "completed" | "failed" | "killed" | "missing";

export type BackgroundBashToolDetails = BashToolDetails & {
  background?: true;
  command?: string;
  cwd?: string;
  description?: string;
  exitFile?: string;
  id?: string;
  outputFile?: string;
  pollIntervalMs?: number;
  startedAt?: number;
  status?: BackgroundShellStatus;
  tmuxSession?: string;
  windowId?: string;
};

export type BackgroundShellRun = Required<
  Pick<
    BackgroundBashToolDetails,
    "command" | "cwd" | "exitFile" | "id" | "outputFile" | "startedAt" | "tmuxSession" | "windowId"
  >
> & {
  completedAt?: number;
  description?: string;
  exitCode?: number;
  pollIntervalMs?: number;
  status: BackgroundShellStatus;
};

export type BackgroundShellMessageDetails = {
  command?: string;
  description?: string;
  exitCode?: number | string;
  outputFile?: string;
  pollLineCount?: number;
  pollOmittedLineCount?: number;
  status?: BackgroundShellStatus | "success";
  windowId?: string;
};
