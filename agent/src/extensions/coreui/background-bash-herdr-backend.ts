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
const HERDR_AVAILABILITY_TIMEOUT_MS = 2000;
const HERDR_PANE_CREATE_TIMEOUT_MS = 5000;
const HERDR_PANE_COMMAND_TIMEOUT_MS = 2000;

export class HerdrBackgroundShellBackend implements BackgroundShellBackend {
  readonly name = "herdr" as const;

  constructor(private readonly exec = execFileAsync) {}

  async isAvailable(cwd: string): Promise<boolean> {
    if (process.env.HERDR_ENV !== "1") return false;
    try {
      await this.exec("herdr", ["status", "server"], {
        cwd,
        timeout: HERDR_AVAILABILITY_TIMEOUT_MS,
      });
      return true;
    } catch {
      return false;
    }
  }

  async launch(input: BackgroundLaunchInput): Promise<BackgroundLaunchResult> {
    const { stdout } = await this.exec(
      "herdr",
      [
        "tab",
        "create",
        ...currentWorkspaceArgs(),
        "--cwd",
        input.cwd,
        "--label",
        input.label,
        "--no-focus",
      ],
      { cwd: input.cwd, encoding: "utf-8", timeout: HERDR_PANE_CREATE_TIMEOUT_MS },
    );
    const paneId = parseHerdrRootPaneId(stdout);
    await this.exec(
      "herdr",
      ["pane", "run", paneId, ` ${wrapCommandWithSelfClose(input.scriptPath, paneId)}`],
      {
        cwd: input.cwd,
        timeout: HERDR_PANE_COMMAND_TIMEOUT_MS,
      },
    );
    return { backend: this.name, targetId: paneId, targetLabel: `herdr pane ${paneId}` };
  }

  async targetExists(run: BackgroundShellRun): Promise<boolean> {
    try {
      await this.exec("herdr", ["pane", "get", run.targetId], {
        timeout: HERDR_PANE_COMMAND_TIMEOUT_MS,
      });
      return true;
    } catch {
      return false;
    }
  }

  async kill(run: BackgroundShellRun): Promise<void> {
    try {
      await this.exec("herdr", ["pane", "close", run.targetId], {
        timeout: HERDR_PANE_COMMAND_TIMEOUT_MS,
      });
    } catch (error) {
      if (!isMissingTargetError(error)) throw error;
    }
  }

  formatInspectHint(run: BackgroundShellRun): string {
    return [
      `Peek while running: herdr pane read ${run.targetId} --source recent-unwrapped --lines 200`,
      `Stop while running: herdr pane close ${run.targetId}`,
      `Output file: ${run.outputFile}`,
      `If pane closed: tail -n 200 ${run.outputFile}`,
    ].join("\n");
  }

  formatPeekHint(run: BackgroundShellRun): string {
    if (run.status !== "running") return `peek: tail -n 200 ${run.outputFile}`;
    return `peek: herdr pane read ${run.targetId} --source recent-unwrapped --lines 200`;
  }

  formatKillHint(run: BackgroundShellRun): string {
    if (run.status !== "running")
      return `kill: unavailable · ${run.status} commands are inspect-only`;
    return `kill: K/x stop · herdr pane close ${run.targetId}`;
  }
}

function currentWorkspaceArgs(): string[] {
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  return workspaceId === undefined || workspaceId.length === 0 ? [] : ["--workspace", workspaceId];
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function wrapCommandWithSelfClose(command: string, paneId: string): string {
  return `{ ${shellEscape(command)}; }; __pi_background_status=$?; herdr pane close ${shellEscape(paneId)}; exit $__pi_background_status`;
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
  return text.includes("not found");
}

function parseHerdrRootPaneId(stdout: string): string {
  const parsed = JSON.parse(stdout) as unknown;
  const paneId = asRecord(asRecord(asRecord(parsed)?.result)?.root_pane)?.pane_id;
  if (typeof paneId !== "string" || paneId.length === 0) {
    throw new Error("herdr tab create did not return root pane id");
  }
  return paneId;
}
