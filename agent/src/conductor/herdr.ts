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
  type HerdrSessionSnapshot,
} from "../herdr/client.js";
import { slugify } from "./run-id.js";
import type { HerdrHandles, RunRecord } from "./store/types.js";

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

export type HerdrSessionLookup = Pick<HerdrRunInput, "owner" | "repo" | "issueNumber" | "slug"> & {
  handles: HerdrHandles;
};

export type HerdrSessionInspection = {
  location?: HerdrLocation;
  agentStatus?: HerdrAgentStatus;
};

export interface HerdrSessionManager {
  launch(input: HerdrRunInput): Promise<HerdrLocation>;
  inspect(inputs: HerdrSessionLookup[]): Promise<HerdrSessionInspection[]>;
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
    let pane =
      tab.paneId === undefined
        ? await this.findPaneForTab(workspaceId, tab.tabId)
        : { paneId: tab.paneId, terminalId: tab.terminalId };
    if (pane === undefined) {
      await this.closeTab(tab.tabId);
      tab = await this.createTab(workspaceId, tabLabel, input.worktreePath);
      pane =
        tab.paneId === undefined
          ? await this.findPaneForTab(workspaceId, tab.tabId)
          : { paneId: tab.paneId, terminalId: tab.terminalId };
    }
    if (pane === undefined) throw new Error(`Herdr tab ${tab.tabId} has no pane`);

    await this.client().runPane(pane.paneId, buildPiLaunchCommand(input), {
      cwd: input.worktreePath,
    });

    return {
      workspaceId,
      tabId: tab.tabId,
      paneId: pane.paneId,
      ...(pane.terminalId === undefined ? {} : { terminalId: pane.terminalId }),
      workspaceLabel,
      tabLabel,
    };
  }

  async inspect(inputs: HerdrSessionLookup[]): Promise<HerdrSessionInspection[]> {
    const snapshot = await this.client().snapshot();
    return inputs.map((input) => inspectHerdrSession(snapshot, input));
  }

  async send(
    handles: HerdrHandles,
    message: string,
    delivery: ConductorDeliveryMode,
  ): Promise<void> {
    if (handles.paneId === undefined) throw new Error("Run has no live Herdr pane handle");
    const client = this.client();
    if (delivery === "steer") {
      await client.runPane(handles.paneId, message);
      return;
    }
    await client.sendInput(handles.paneId, message, SUBMIT_KEYS[delivery]);
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
  ): Promise<{ tabId: string; paneId?: string; terminalId?: string }> {
    const existing = (await this.listTabs(workspaceId)).find((entry) => entry.label === label);
    if (existing !== undefined) return { tabId: existing.tabId };

    return this.createTab(workspaceId, label, cwd);
  }

  private async createTab(
    workspaceId: string,
    label: string,
    cwd: string,
  ): Promise<{ tabId: string; paneId?: string; terminalId?: string }> {
    const tab = await this.client().createTab({ cwd, label, workspaceId });
    if (tab.tabId === undefined) throw new Error("herdr tab create did not return tab_id");
    return {
      tabId: tab.tabId,
      paneId: tab.paneId,
      ...(tab.terminalId === undefined ? {} : { terminalId: tab.terminalId }),
    };
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

  private async findPaneForTab(
    workspaceId: string,
    tabId: string,
  ): Promise<{ paneId: string; terminalId?: string } | undefined> {
    const pane = (await this.client().listPanes(workspaceId)).find(
      (entry) => entry.tabId === tabId,
    );
    if (pane === undefined) return undefined;
    return {
      paneId: pane.paneId,
      ...(pane.terminalId === undefined ? {} : { terminalId: pane.terminalId }),
    };
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

export function herdrLookupForRun(run: RunRecord): HerdrSessionLookup {
  return {
    handles: run.herdr,
    owner: run.owner,
    repo: run.repo,
    issueNumber: run.issueNumber,
    slug: slugify(run.issueTitle),
  };
}

export function sameHerdrHandles(current: HerdrHandles, next: HerdrHandles): boolean {
  return (
    current.workspaceId === next.workspaceId &&
    current.tabId === next.tabId &&
    current.paneId === next.paneId &&
    current.terminalId === next.terminalId
  );
}

function inspectHerdrSession(
  snapshot: HerdrSessionSnapshot,
  input: HerdrSessionLookup,
): HerdrSessionInspection {
  const expectedWorkspaceLabel = repositoryWorkspaceLabel(input.owner, input.repo);
  const expectedTabLabel = issueTabLabel(input.issueNumber, input.slug);
  const paneByHandle =
    (input.handles.terminalId === undefined
      ? undefined
      : snapshot.panes.find((entry) => entry.terminalId === input.handles.terminalId)) ??
    (input.handles.paneId === undefined
      ? undefined
      : snapshot.panes.find((entry) => entry.paneId === input.handles.paneId));
  const workspace =
    paneByHandle === undefined
      ? snapshot.workspaces.find((entry) => entry.label === expectedWorkspaceLabel)
      : snapshot.workspaces.find((entry) => entry.workspaceId === paneByHandle.workspaceId);
  const tab =
    paneByHandle === undefined
      ? snapshot.tabs.find(
          (entry) =>
            entry.workspaceId === workspace?.workspaceId && entry.label === expectedTabLabel,
        )
      : snapshot.tabs.find((entry) => entry.tabId === paneByHandle.tabId);
  let pane = paneByHandle;
  if (pane === undefined && tab !== undefined) {
    pane = snapshot.panes.find((entry) => entry.tabId === tab.tabId);
  }
  if (pane === undefined || workspace === undefined || tab === undefined) return {};

  return {
    agentStatus: pane.agentStatus,
    location: {
      workspaceId: workspace.workspaceId,
      tabId: tab.tabId,
      paneId: pane.paneId,
      terminalId: pane.terminalId,
      workspaceLabel: workspace.label,
      tabLabel: tab.label,
    },
  };
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
