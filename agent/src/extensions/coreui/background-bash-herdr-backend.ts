import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  HerdrClient,
  currentHerdrWorkspaceId,
  isMissingHerdrTarget,
  isRunningInHerdr,
} from "../../herdr/client.js";
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
    if (!isRunningInHerdr()) return false;
    try {
      await this.client().statusServer({
        cwd,
        timeout: HERDR_AVAILABILITY_TIMEOUT_MS,
      });
      return true;
    } catch {
      return false;
    }
  }

  async launch(input: BackgroundLaunchInput): Promise<BackgroundLaunchResult> {
    const client = this.client();
    const { paneId } = await client.createTab({
      cwd: input.cwd,
      label: input.label,
      workspaceId: currentHerdrWorkspaceId(),
      timeout: HERDR_PANE_CREATE_TIMEOUT_MS,
    });
    await client.runPane(paneId, ` ${wrapCommandWithSelfClose(input.scriptPath, paneId)}`, {
      cwd: input.cwd,
      timeout: HERDR_PANE_COMMAND_TIMEOUT_MS,
    });
    return { backend: this.name, targetId: paneId, targetLabel: `herdr pane ${paneId}` };
  }

  async targetExists(run: BackgroundShellRun): Promise<boolean> {
    try {
      return await this.client().paneExists(run.targetId, {
        timeout: HERDR_PANE_COMMAND_TIMEOUT_MS,
      });
    } catch {
      return false;
    }
  }

  async kill(run: BackgroundShellRun): Promise<void> {
    try {
      await this.client().closePane(run.targetId, {
        timeout: HERDR_PANE_COMMAND_TIMEOUT_MS,
      });
    } catch (error) {
      if (!isMissingHerdrTarget(error)) throw error;
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

  private client(): HerdrClient {
    return new HerdrClient(async (args, options) => {
      const result = await this.exec("herdr", args, {
        ...options,
        encoding: "utf-8",
      });
      return { stdout: result.stdout, stderr: result.stderr };
    });
  }
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function wrapCommandWithSelfClose(command: string, paneId: string): string {
  return `{ ${shellEscape(command)}; }; __pi_background_status=$?; herdr pane close ${shellEscape(paneId)}; exit $__pi_background_status`;
}
