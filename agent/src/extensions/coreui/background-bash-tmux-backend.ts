import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { asRecord, readString } from "../../utils/unknown-data.js";
import type {
  BackgroundLaunchInput,
  BackgroundLaunchResult,
  BackgroundShellBackend,
} from "./background-bash-backend.js";
import type { BackgroundShellRun } from "./background-bash-types.js";

const execFileAsync = promisify(execFile);
const BACKGROUND_SESSION_NAME = "pi-background";
const TMUX_AVAILABILITY_TIMEOUT_MS = 2000;
const TMUX_SESSION_TIMEOUT_MS = 2000;
const TMUX_WINDOW_CREATE_TIMEOUT_MS = 5000;
const TMUX_WINDOW_OPTION_TIMEOUT_MS = 2000;
const TMUX_WINDOW_EXISTS_TIMEOUT_MS = 2000;
const TMUX_KILL_TIMEOUT_MS = 2000;
const TMUX_WINDOW_OPTIONS = {
  command: "@pi-bg-command",
  cwd: "@pi-bg-cwd",
  description: "@pi-bg-description",
  exitFile: "@pi-bg-exit-file",
  id: "@pi-bg-id",
  outputFile: "@pi-bg-output-file",
  pollIntervalMs: "@pi-bg-poll-interval-ms",
  startedAt: "@pi-bg-started-at",
} as const;

type TargetSession = {
  exists: boolean;
  name: string;
};

export class TmuxBackgroundShellBackend implements BackgroundShellBackend {
  readonly name = "tmux" as const;

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync("tmux", ["-V"], { timeout: TMUX_AVAILABILITY_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  }

  async launch(input: BackgroundLaunchInput): Promise<BackgroundLaunchResult> {
    const session = await resolveTargetSession(input.cwd);
    const windowId = await createTmuxWindow(session, input.cwd, input.label, input.scriptPath);
    await tagTmuxWindow(windowId, input, session.name);
    return {
      backend: this.name,
      muxSession: session.name,
      targetId: windowId,
      targetLabel: `tmux window ${windowId}`,
    };
  }

  async targetExists(run: BackgroundShellRun): Promise<boolean> {
    try {
      await execFileAsync("tmux", ["display-message", "-p", "-t", run.targetId, "#{window_id}"], {
        timeout: TMUX_WINDOW_EXISTS_TIMEOUT_MS,
      });
      return true;
    } catch {
      return false;
    }
  }

  async kill(run: BackgroundShellRun): Promise<void> {
    try {
      await execFileAsync("tmux", ["kill-window", "-t", run.targetId], {
        timeout: TMUX_KILL_TIMEOUT_MS,
      });
    } catch (error) {
      if (!isMissingTargetError(error)) throw error;
    }
  }

  formatInspectHint(run: BackgroundShellRun): string {
    return [
      `Peek while running: tmux capture-pane -t ${run.targetId} -p -S -200`,
      `Stop while running: tmux kill-window -t ${run.targetId}`,
      `Output file: ${run.outputFile}`,
      `If window closed: tail -n 200 ${run.outputFile}`,
    ].join("\n");
  }

  formatPeekHint(run: BackgroundShellRun): string {
    if (run.status !== "running") return `peek: tail -n 200 ${run.outputFile}`;
    return `peek: tmux capture-pane -t ${run.targetId} -p -S -200`;
  }

  formatKillHint(run: BackgroundShellRun): string {
    if (run.status !== "running")
      return `kill: unavailable · ${run.status} commands are inspect-only`;
    return `kill: K/x stop · tmux kill-window -t ${run.targetId}`;
  }
}

function isMissingTargetError(error: unknown): boolean {
  const record = asRecord(error);
  const text = [
    readString(record?.stderr),
    readString(record?.stdout),
    error instanceof Error ? error.message : undefined,
  ]
    .filter((value) => value !== undefined)
    .join("\n")
    .toLowerCase();
  return text.includes("can't find") || text.includes("not found");
}

export const TAGGED_TMUX_WINDOW_FORMAT = [
  "#{session_name}",
  "#{window_id}",
  `#{${TMUX_WINDOW_OPTIONS.id}}`,
  `#{${TMUX_WINDOW_OPTIONS.command}}`,
  `#{${TMUX_WINDOW_OPTIONS.description}}`,
  `#{${TMUX_WINDOW_OPTIONS.cwd}}`,
  `#{${TMUX_WINDOW_OPTIONS.exitFile}}`,
  `#{${TMUX_WINDOW_OPTIONS.outputFile}}`,
  `#{${TMUX_WINDOW_OPTIONS.startedAt}}`,
  `#{${TMUX_WINDOW_OPTIONS.pollIntervalMs}}`,
].join("\t");

async function tagTmuxWindow(
  windowId: string,
  input: BackgroundLaunchInput,
  muxSession: string,
): Promise<void> {
  const values: Record<string, string> = {
    [TMUX_WINDOW_OPTIONS.command]: input.command,
    [TMUX_WINDOW_OPTIONS.cwd]: input.cwd,
    [TMUX_WINDOW_OPTIONS.description]: input.description,
    [TMUX_WINDOW_OPTIONS.exitFile]: input.exitFile,
    [TMUX_WINDOW_OPTIONS.id]: input.id,
    [TMUX_WINDOW_OPTIONS.outputFile]: input.outputFile,
    [TMUX_WINDOW_OPTIONS.startedAt]: String(input.startedAt),
  };
  if (input.pollIntervalMs !== undefined)
    values[TMUX_WINDOW_OPTIONS.pollIntervalMs] = String(input.pollIntervalMs);

  await Promise.all(
    Object.entries(values).map(([option, value]) =>
      execFileAsync("tmux", ["set-window-option", "-q", "-t", windowId, option, value], {
        timeout: TMUX_WINDOW_OPTION_TIMEOUT_MS,
      }),
    ),
  );
  void muxSession;
}

async function resolveTargetSession(cwd: string): Promise<TargetSession> {
  if (process.env.TMUX !== undefined && process.env.TMUX.length > 0) {
    const { stdout } = await execFileAsync("tmux", ["display-message", "-p", "#S"], {
      cwd,
      encoding: "utf-8",
      timeout: TMUX_SESSION_TIMEOUT_MS,
    });
    const currentSession = stdout.trim();
    if (currentSession.length > 0) return { exists: true, name: currentSession };
  }

  try {
    await execFileAsync("tmux", ["has-session", "-t", BACKGROUND_SESSION_NAME], {
      cwd,
      encoding: "utf-8",
      timeout: TMUX_SESSION_TIMEOUT_MS,
    });
    return { exists: true, name: BACKGROUND_SESSION_NAME };
  } catch {
    return { exists: false, name: BACKGROUND_SESSION_NAME };
  }
}

async function createTmuxWindow(
  session: TargetSession,
  cwd: string,
  windowName: string,
  scriptPath: string,
): Promise<string> {
  if (session.exists) {
    const { stdout } = await execFileAsync(
      "tmux",
      [
        "new-window",
        "-d",
        "-t",
        session.name,
        "-c",
        cwd,
        "-n",
        windowName,
        "-P",
        "-F",
        "#{window_id}",
        scriptPath,
      ],
      { cwd, encoding: "utf-8", timeout: TMUX_WINDOW_CREATE_TIMEOUT_MS },
    );
    return stdout.trim();
  }

  const { stdout } = await execFileAsync(
    "tmux",
    [
      "new-session",
      "-d",
      "-s",
      session.name,
      "-c",
      cwd,
      "-n",
      windowName,
      "-P",
      "-F",
      "#{window_id}",
      scriptPath,
    ],
    { cwd, encoding: "utf-8", timeout: TMUX_WINDOW_CREATE_TIMEOUT_MS },
  );
  return stdout.trim();
}
