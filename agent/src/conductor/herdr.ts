import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  HerdrClient,
  isMissingHerdrTarget,
  parseHerdrAgentStatus,
  parseHerdrPanes,
  parseHerdrTabs,
  parseHerdrWorkspaces,
  type HerdrAgentStatus,
} from "../herdr/client.js";
import type { HerdrHandles } from "./store/types.js";

const execFileAsync = promisify(execFile);

const SUBMIT_KEYS = {
  steer: "enter",
  followUp: "alt+enter",
} as const;
const HERDR_COMMAND_TIMEOUT_MS = 10_000;

export type ConductorDeliveryMode = keyof typeof SUBMIT_KEYS;
export type { HerdrAgentStatus } from "../herdr/client.js";
export { parseHerdrAgentStatus, parseHerdrPanes, parseHerdrTabs, parseHerdrWorkspaces };

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

    await this.client().runPane(paneId, buildPiLaunchCommand(input), { cwd: input.worktreePath });

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
    const client = this.client();
    await client.sendText(handles.paneId, `\u001B[200~${message}\u001B[201~`);
    await client.sendKeys(handles.paneId, SUBMIT_KEYS[delivery]);
  }

  paneExists(handles: HerdrHandles): Promise<boolean> {
    if (handles.paneId === undefined) return Promise.resolve(false);
    return this.client().paneExists(handles.paneId);
  }

  async agentStatus(handles: HerdrHandles): Promise<HerdrAgentStatus | undefined> {
    if (handles.paneId === undefined) return undefined;
    try {
      return await this.client().agentStatus(handles.paneId);
    } catch (error) {
      if (isMissingHerdrTarget(error)) return undefined;
      throw error;
    }
  }

  async stop(handles: HerdrHandles): Promise<void> {
    if (handles.paneId === undefined) return;
    try {
      await this.client().closePane(handles.paneId);
    } catch (error) {
      if (!isMissingHerdrTarget(error)) throw error;
    }
  }

  private async ensureWorkspace(label: string, cwd: string): Promise<string> {
    const existing = (await this.listWorkspaces()).find((entry) => entry.label === label);
    if (existing !== undefined) return existing.workspaceId;

    return this.client().createWorkspace({ cwd, label });
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
    const tab = await this.client().createTab({ cwd, label, workspaceId });
    if (tab.tabId === undefined) throw new Error("herdr tab create did not return tab_id");
    return { tabId: tab.tabId, paneId: tab.paneId };
  }

  private async closeTab(tabId: string): Promise<void> {
    try {
      await this.client().closeTab(tabId);
    } catch (error) {
      if (!isMissingHerdrTarget(error)) throw error;
    }
  }

  private listWorkspaces(): Promise<Array<{ workspaceId: string; label: string }>> {
    return this.client().listWorkspaces();
  }

  private listTabs(workspaceId: string): Promise<Array<{ tabId: string; label: string }>> {
    return this.client().listTabs(workspaceId);
  }

  private async findPaneForTab(workspaceId: string, tabId: string): Promise<string | undefined> {
    return (await this.client().listPanes(workspaceId)).find((pane) => pane.tabId === tabId)
      ?.paneId;
  }

  private client(): HerdrClient {
    return new HerdrClient((args, options) =>
      this.exec("herdr", args, {
        cwd: options.cwd,
        timeout: options.timeout ?? HERDR_COMMAND_TIMEOUT_MS,
      }),
    );
  }
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

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
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
