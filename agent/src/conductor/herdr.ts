import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { asRecord, readString } from "../utils/unknown-data.js";
import { parseJsonValue } from "./json.js";
import type { HerdrHandles } from "./store/types.js";

const execFileAsync = promisify(execFile);

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

const SUBMIT_KEYS = {
  steer: "enter",
  followUp: "alt+enter",
} as const;
const HERDR_COMMAND_TIMEOUT_MS = 10_000;

export type ConductorDeliveryMode = keyof typeof SUBMIT_KEYS;
export type HerdrAgentStatus = Static<typeof HerdrAgentStatusSchema>;

export type HerdrRunInput = {
  owner: string;
  repo: string;
  issueNumber: number;
  slug: string;
  repoPath: string;
  worktreePath: string;
  launchFlags: string[];
  promptRelativePath: string;
};

export type HerdrLocation = HerdrHandles & {
  workspaceLabel: string;
  tabLabel: string;
};

export interface HerdrSessionManager {
  launch(input: HerdrRunInput): Promise<HerdrLocation>;
  find(
    input: Pick<HerdrRunInput, "owner" | "repo" | "issueNumber" | "slug">,
  ): Promise<HerdrLocation | undefined>;
  paneExists(handles: HerdrHandles): Promise<boolean>;
  agentStatus(handles: HerdrHandles): Promise<HerdrAgentStatus | undefined>;
  send(handles: HerdrHandles, message: string, delivery: ConductorDeliveryMode): Promise<void>;
  stop(handles: HerdrHandles): Promise<void>;
}

export type HerdrExec = (
  file: string,
  args: string[],
  options: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

export class CliHerdrSessionManager implements HerdrSessionManager {
  constructor(private readonly exec: HerdrExec = defaultHerdrExec) {}

  async launch(input: HerdrRunInput): Promise<HerdrLocation> {
    const workspaceLabel = repositoryWorkspaceLabel(input.owner, input.repo);
    const tabLabel = issueTabLabel(input.issueNumber, input.slug);
    const workspaceId = await this.ensureWorkspace(workspaceLabel, input.repoPath);
    let tab = await this.ensureTab(workspaceId, tabLabel, input.worktreePath);
    let paneId = tab.paneId ?? (await this.findPaneForTab(workspaceId, tab.tabId));
    if (paneId === undefined) {
      await this.closeTab(tab.tabId);
      tab = await this.createTab(workspaceId, tabLabel, input.worktreePath);
      paneId = tab.paneId ?? (await this.findPaneForTab(workspaceId, tab.tabId));
    }
    if (paneId === undefined) throw new Error(`Herdr tab ${tab.tabId} has no pane`);

    await this.herdr(
      ["pane", "run", paneId, buildPiLaunchCommand(input)],
      input.worktreePath,
      "herdr pane run",
    );

    return { workspaceId, tabId: tab.tabId, paneId, workspaceLabel, tabLabel };
  }

  async find(
    input: Pick<HerdrRunInput, "owner" | "repo" | "issueNumber" | "slug">,
  ): Promise<HerdrLocation | undefined> {
    const workspaceLabel = repositoryWorkspaceLabel(input.owner, input.repo);
    const tabLabel = issueTabLabel(input.issueNumber, input.slug);
    const workspace = (await this.listWorkspaces()).find((entry) => entry.label === workspaceLabel);
    if (workspace === undefined) return undefined;
    const tab = (await this.listTabs(workspace.workspaceId)).find(
      (entry) => entry.label === tabLabel,
    );
    if (tab === undefined) return undefined;
    return {
      workspaceId: workspace.workspaceId,
      tabId: tab.tabId,
      paneId: await this.findPaneForTab(workspace.workspaceId, tab.tabId),
      workspaceLabel,
      tabLabel,
    };
  }

  async send(
    handles: HerdrHandles,
    message: string,
    delivery: ConductorDeliveryMode,
  ): Promise<void> {
    if (handles.paneId === undefined) throw new Error("Run has no live Herdr pane handle");
    await this.herdr(
      ["pane", "send-text", handles.paneId, `\u001B[200~${message}\u001B[201~`],
      undefined,
      "herdr pane send-text",
    );
    await this.herdr(
      ["pane", "send-keys", handles.paneId, SUBMIT_KEYS[delivery]],
      undefined,
      "herdr pane send-keys",
    );
  }

  async paneExists(handles: HerdrHandles): Promise<boolean> {
    if (handles.paneId === undefined) return false;
    try {
      await this.herdr(["pane", "get", handles.paneId], undefined, "herdr pane get");
      return true;
    } catch (error) {
      if (isMissingHerdrTarget(error)) return false;
      throw error;
    }
  }

  async agentStatus(handles: HerdrHandles): Promise<HerdrAgentStatus | undefined> {
    if (handles.paneId === undefined) return undefined;
    try {
      return parseHerdrAgentStatus(
        await this.herdr(["agent", "get", handles.paneId], undefined, "herdr agent get"),
      );
    } catch (error) {
      if (isMissingHerdrTarget(error)) return undefined;
      throw error;
    }
  }

  async stop(handles: HerdrHandles): Promise<void> {
    if (handles.paneId === undefined) return;
    try {
      await this.herdr(["pane", "close", handles.paneId], undefined, "herdr pane close");
    } catch (error) {
      if (!isMissingHerdrTarget(error)) throw error;
    }
  }

  private async ensureWorkspace(label: string, cwd: string): Promise<string> {
    const existing = (await this.listWorkspaces()).find((entry) => entry.label === label);
    if (existing !== undefined) return existing.workspaceId;

    const response = parseHerdrResponse(
      await this.herdr(
        ["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"],
        cwd,
        "herdr workspace create",
      ),
      "herdr workspace create",
    );
    const workspaceId =
      readString(asRecord(response.result.workspace)?.workspace_id) ??
      readString(response.result.workspace_id);
    if (workspaceId === undefined)
      throw new Error("herdr workspace create did not return workspace_id");
    return workspaceId;
  }

  private async ensureTab(
    workspaceId: string,
    label: string,
    cwd: string,
  ): Promise<{ tabId: string; paneId?: string }> {
    const existing = (await this.listTabs(workspaceId)).find((entry) => entry.label === label);
    if (existing !== undefined) return { tabId: existing.tabId };

    return this.createTab(workspaceId, label, cwd);
  }

  private async createTab(
    workspaceId: string,
    label: string,
    cwd: string,
  ): Promise<{ tabId: string; paneId?: string }> {
    const response = parseHerdrResponse(
      await this.herdr(
        ["tab", "create", "--workspace", workspaceId, "--cwd", cwd, "--label", label, "--no-focus"],
        cwd,
        "herdr tab create",
      ),
      "herdr tab create",
    );
    const tabId =
      readString(asRecord(response.result.tab)?.tab_id) ?? readString(response.result.tab_id);
    const paneId =
      readString(asRecord(response.result.root_pane)?.pane_id) ??
      readString(asRecord(response.result.pane)?.pane_id);
    if (tabId === undefined) throw new Error("herdr tab create did not return tab_id");
    return { tabId, paneId };
  }

  private async closeTab(tabId: string): Promise<void> {
    try {
      await this.herdr(["tab", "close", tabId], undefined, "herdr tab close");
    } catch (error) {
      if (!isMissingHerdrTarget(error)) throw error;
    }
  }

  private async listWorkspaces(): Promise<Array<{ workspaceId: string; label: string }>> {
    return parseHerdrWorkspaces(
      await this.herdr(["workspace", "list"], undefined, "herdr workspace list"),
    );
  }

  private async listTabs(workspaceId: string): Promise<Array<{ tabId: string; label: string }>> {
    return parseHerdrTabs(
      await this.herdr(["tab", "list", "--workspace", workspaceId], undefined, "herdr tab list"),
    );
  }

  private async findPaneForTab(workspaceId: string, tabId: string): Promise<string | undefined> {
    return parseHerdrPanes(
      await this.herdr(["pane", "list", "--workspace", workspaceId], undefined, "herdr pane list"),
    ).find((pane) => pane.tabId === tabId)?.paneId;
  }

  private async herdr(args: string[], cwd: string | undefined, _action: string): Promise<string> {
    const result = await this.exec("herdr", args, { cwd, timeout: HERDR_COMMAND_TIMEOUT_MS });
    return result.stdout.trim();
  }
}

export function parseHerdrWorkspaces(
  stdout: string,
): Array<{ workspaceId: string; label: string }> {
  const response = parseHerdrResponse(stdout, "herdr workspace list");
  return readHerdrList(response.result.workspaces).flatMap((entry) => {
    const workspaceId = readString(entry.workspace_id);
    const label = readString(entry.label);
    return workspaceId === undefined || label === undefined ? [] : [{ workspaceId, label }];
  });
}

export function parseHerdrTabs(stdout: string): Array<{ tabId: string; label: string }> {
  const response = parseHerdrResponse(stdout, "herdr tab list");
  return readHerdrList(response.result.tabs).flatMap((entry) => {
    const tabId = readString(entry.tab_id);
    const label = readString(entry.label);
    return tabId === undefined || label === undefined ? [] : [{ tabId, label }];
  });
}

export function parseHerdrPanes(stdout: string): Array<{ paneId: string; tabId: string }> {
  const response = parseHerdrResponse(stdout, "herdr pane list");
  return readHerdrList(response.result.panes).flatMap((entry) => {
    const paneId = readString(entry.pane_id);
    const tabId = readString(entry.tab_id);
    return paneId === undefined || tabId === undefined ? [] : [{ paneId, tabId }];
  });
}

export function parseHerdrAgentStatus(stdout: string): HerdrAgentStatus | undefined {
  const response = parseHerdrResponse(stdout, "herdr agent get");
  const status = readString(asRecord(response.result.agent)?.agent_status);
  return status !== undefined && Value.Check(HerdrAgentStatusSchema, status) ? status : undefined;
}

export function repositoryWorkspaceLabel(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

export function issueTabLabel(issueNumber: number, slug: string): string {
  return `#${issueNumber} ${slug}`;
}

export function deliveryModeToSubmitKey(delivery: ConductorDeliveryMode): string {
  return SUBMIT_KEYS[delivery];
}

function buildPiLaunchCommand(input: HerdrRunInput): string {
  return [
    "pi",
    "--name",
    shellEscape(`${input.owner}/${input.repo}#${input.issueNumber}`),
    ...input.launchFlags.map(shellEscape),
    shellEscape(`@${input.promptRelativePath}`),
  ].join(" ");
}

function parseHerdrResponse(stdout: string, label: string): { result: Record<string, unknown> } {
  return Value.Parse(HerdrResponseSchema, parseJsonValue(stdout, label));
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

function isMissingHerdrTarget(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("not found");
}

async function defaultHerdrExec(
  file: string,
  args: string[],
  options: { cwd?: string; timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(file, args, {
    cwd: options.cwd,
    timeout: options.timeout,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}
