import { Type } from "typebox";
import { Value } from "typebox/value";

import { errorMessage } from "../utils/error-message.js";
import { asRecord, readString } from "../utils/unknown-data.js";

const HerdrResponseSchema = Type.Object({
  result: Type.Record(Type.String(), Type.Unknown()),
});
const HerdrAgentStatusSchema = Type.Union([
  Type.Literal("idle"),
  Type.Literal("working"),
  Type.Literal("blocked"),
  Type.Literal("done"),
  Type.Literal("unknown"),
]);

export type HerdrCommandOptions = {
  cwd?: string;
  timeout?: number;
};

export type HerdrRunUntilExitOptions = HerdrCommandOptions & {
  restoreTabId?: string;
};

export type HerdrCommandResult = {
  code?: number;
  stdout: string;
  stderr: string;
};

export type HerdrCommandExecutor = (
  args: string[],
  options: HerdrCommandOptions,
) => Promise<HerdrCommandResult>;

export type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export type HerdrWorkspace = {
  workspaceId: string;
  label: string;
};

export type HerdrTab = {
  tabId: string;
  label: string;
};

export type HerdrPane = {
  paneId: string;
  tabId: string;
};

export type HerdrCreatedTab = {
  paneId: string;
  tabId?: string;
};

export function isRunningInHerdr(): boolean {
  return process.env.HERDR_ENV === "1";
}

export function currentHerdrWorkspaceId(): string | undefined {
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  return workspaceId === undefined || workspaceId.length === 0 ? undefined : workspaceId;
}

export function currentHerdrTabId(): string | undefined {
  const tabId = process.env.HERDR_TAB_ID;
  return tabId === undefined || tabId.length === 0 ? undefined : tabId;
}

export function parseHerdrWorkspaces(stdout: string): HerdrWorkspace[] {
  return readHerdrList(parseHerdrResponse(stdout, "workspace list").result.workspaces).flatMap(
    (entry) => {
      const workspaceId = readString(entry.workspace_id);
      const label = readString(entry.label);
      return workspaceId === undefined || label === undefined ? [] : [{ workspaceId, label }];
    },
  );
}

export function parseHerdrTabs(stdout: string): HerdrTab[] {
  return readHerdrList(parseHerdrResponse(stdout, "tab list").result.tabs).flatMap((entry) => {
    const tabId = readString(entry.tab_id);
    const label = readString(entry.label);
    return tabId === undefined || label === undefined ? [] : [{ tabId, label }];
  });
}

export function parseHerdrPanes(stdout: string): HerdrPane[] {
  return readHerdrList(parseHerdrResponse(stdout, "pane list").result.panes).flatMap((entry) => {
    const paneId = readString(entry.pane_id);
    const tabId = readString(entry.tab_id);
    return paneId === undefined || tabId === undefined ? [] : [{ paneId, tabId }];
  });
}

export function parseHerdrAgentStatus(stdout: string): HerdrAgentStatus | undefined {
  const status = readString(
    asRecord(parseHerdrResponse(stdout, "agent get").result.agent)?.agent_status,
  );
  return status !== undefined && Value.Check(HerdrAgentStatusSchema, status) ? status : undefined;
}

export function isMissingHerdrTarget(error: unknown): boolean {
  const record = asRecord(error);
  const message = [
    readString(record?.stderr),
    readString(record?.stdout),
    error instanceof Error ? error.message : undefined,
  ]
    .filter((value) => value !== undefined)
    .join("\n")
    .toLowerCase();
  return message.includes("not found");
}

export class HerdrClient {
  constructor(private readonly execute: HerdrCommandExecutor) {}

  async statusServer(options: HerdrCommandOptions): Promise<void> {
    await this.run(["status", "server"], options, "status server");
  }

  async createWorkspace(input: {
    cwd: string;
    label: string;
    focus?: boolean;
    timeout?: number;
  }): Promise<string> {
    const response = parseHerdrResponse(
      await this.run(
        [
          "workspace",
          "create",
          "--cwd",
          input.cwd,
          "--label",
          input.label,
          ...(input.focus === true ? [] : ["--no-focus"]),
        ],
        { cwd: input.cwd, timeout: input.timeout },
        "workspace create",
      ),
      "workspace create",
    );
    const workspaceId =
      readString(asRecord(response.result.workspace)?.workspace_id) ??
      readString(response.result.workspace_id);
    if (workspaceId === undefined) {
      throw new Error("herdr workspace create did not return workspace_id");
    }
    return workspaceId;
  }

  async createTab(input: {
    cwd: string;
    label: string;
    workspaceId?: string;
    focus?: boolean;
    timeout?: number;
  }): Promise<HerdrCreatedTab> {
    const response = parseHerdrResponse(
      await this.run(
        [
          "tab",
          "create",
          ...(input.workspaceId === undefined ? [] : ["--workspace", input.workspaceId]),
          "--cwd",
          input.cwd,
          "--label",
          input.label,
          ...(input.focus === true ? [] : ["--no-focus"]),
        ],
        { cwd: input.cwd, timeout: input.timeout },
        "tab create",
      ),
      "tab create",
    );
    const paneId =
      readString(asRecord(response.result.root_pane)?.pane_id) ??
      readString(asRecord(response.result.pane)?.pane_id);
    if (paneId === undefined) {
      throw new Error("herdr tab create did not return a root pane id");
    }
    const tabId =
      readString(asRecord(response.result.tab)?.tab_id) ?? readString(response.result.tab_id);
    if (input.focus === true && tabId === undefined) {
      throw new Error("herdr tab create did not return a tab id to focus");
    }
    if (input.focus === true && tabId !== undefined) {
      await this.focusTab(tabId, { cwd: input.cwd, timeout: input.timeout });
    }
    return tabId === undefined ? { paneId } : { paneId, tabId };
  }

  async splitPane(input: {
    cwd: string;
    direction: "right" | "down";
    paneId: string;
    focus?: boolean;
    timeout?: number;
  }): Promise<string> {
    const response = parseHerdrResponse(
      await this.run(
        [
          "pane",
          "split",
          input.paneId,
          "--direction",
          input.direction,
          "--cwd",
          input.cwd,
          ...(input.focus === true ? [] : ["--no-focus"]),
        ],
        { cwd: input.cwd, timeout: input.timeout },
        "pane split",
      ),
      "pane split",
    );
    const paneId = readString(asRecord(response.result.pane)?.pane_id);
    if (paneId === undefined) {
      throw new Error("herdr pane split did not return a pane id");
    }
    return paneId;
  }

  async listWorkspaces(options: HerdrCommandOptions = {}): Promise<HerdrWorkspace[]> {
    return parseHerdrWorkspaces(await this.run(["workspace", "list"], options, "workspace list"));
  }

  async listTabs(workspaceId: string, options: HerdrCommandOptions = {}): Promise<HerdrTab[]> {
    return parseHerdrTabs(
      await this.run(["tab", "list", "--workspace", workspaceId], options, "tab list"),
    );
  }

  async listPanes(workspaceId: string, options: HerdrCommandOptions = {}): Promise<HerdrPane[]> {
    return parseHerdrPanes(
      await this.run(["pane", "list", "--workspace", workspaceId], options, "pane list"),
    );
  }

  async runPane(paneId: string, command: string, options: HerdrCommandOptions = {}): Promise<void> {
    await this.run(["pane", "run", paneId, command], options, "pane run");
  }

  async runPaneUntilExit(
    paneId: string,
    command: string,
    options: HerdrRunUntilExitOptions = {},
  ): Promise<void> {
    const { restoreTabId, ...commandOptions } = options;
    const restoreTabCommand =
      restoreTabId === undefined ? "" : `herdr tab focus ${shellEscape(restoreTabId)}; `;
    const wrappedCommand = `{ ${command}; }; __herdr_pane_status=$?; ${restoreTabCommand}herdr pane close ${shellEscape(paneId)}; exit $__herdr_pane_status`;
    await this.runPane(paneId, wrappedCommand, commandOptions);
  }

  async renamePane(
    paneId: string,
    label: string,
    options: HerdrCommandOptions = {},
  ): Promise<void> {
    await this.run(["pane", "rename", paneId, label], options, "pane rename");
  }

  async focusTab(tabId: string, options: HerdrCommandOptions = {}): Promise<void> {
    await this.run(["tab", "focus", tabId], options, "tab focus");
  }

  async sendText(paneId: string, text: string, options: HerdrCommandOptions = {}): Promise<void> {
    await this.run(["pane", "send-text", paneId, text], options, "pane send-text");
  }

  async sendKeys(paneId: string, key: string, options: HerdrCommandOptions = {}): Promise<void> {
    await this.run(["pane", "send-keys", paneId, key], options, "pane send-keys");
  }

  async paneExists(paneId: string, options: HerdrCommandOptions = {}): Promise<boolean> {
    try {
      await this.run(["pane", "get", paneId], options, "pane get");
      return true;
    } catch (error) {
      if (isMissingHerdrTarget(error)) return false;
      throw error;
    }
  }

  async closePane(paneId: string, options: HerdrCommandOptions = {}): Promise<void> {
    await this.run(["pane", "close", paneId], options, "pane close");
  }

  async closeTab(tabId: string, options: HerdrCommandOptions = {}): Promise<void> {
    await this.run(["tab", "close", tabId], options, "tab close");
  }

  readPane(paneId: string, lines: number, options: HerdrCommandOptions = {}): Promise<string> {
    return this.run(
      ["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)],
      options,
      "pane read",
    );
  }

  async agentStatus(
    paneId: string,
    options: HerdrCommandOptions = {},
  ): Promise<HerdrAgentStatus | undefined> {
    return parseHerdrAgentStatus(await this.run(["agent", "get", paneId], options, "agent get"));
  }

  private async run(args: string[], options: HerdrCommandOptions, action: string): Promise<string> {
    const result = await this.execute(args, options);
    if (result.code === undefined || result.code === 0) {
      return result.stdout;
    }
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    throw new Error(`herdr ${action} failed: ${detail}`);
  }
}

function parseHerdrResponse(stdout: string, action: string): { result: Record<string, unknown> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new Error(`herdr ${action} returned invalid JSON: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  return Value.Parse(HerdrResponseSchema, parsed);
}

function readHerdrList(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    return record === undefined ? [] : [record];
  });
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
