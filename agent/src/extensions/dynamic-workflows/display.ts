import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowMeta } from "./workflow.js";

export type WorkflowAgentStatus = "queued" | "running" | "done" | "error" | "skipped";

export type WorkflowAgentActivityKind =
  | "thinking"
  | "tool_start"
  | "tool_update"
  | "tool_end"
  | "message"
  | "error";

export interface WorkflowAgentActivityEvent {
  kind: WorkflowAgentActivityKind;
  label: string;
  detail?: string;
  toolName?: string;
  timestamp: number;
  done?: boolean;
}

export interface WorkflowAgentSnapshot {
  id: number;
  label: string;
  phase?: string;
  prompt: string;
  status: WorkflowAgentStatus;
  resultPreview?: string;
  error?: string;
  /** Tokens used by this agent. */
  tokens?: number;
  /** The model this agent ran on (provider/id), when known. */
  model?: string;
  activity?: string;
  activityEvents?: WorkflowAgentActivityEvent[];
}

export interface WorkflowSnapshot {
  name: string;
  description?: string;
  phases: string[];
  currentPhase?: string;
  logs: string[];
  agents: WorkflowAgentSnapshot[];
  agentCount: number;
  runningCount: number;
  doneCount: number;
  errorCount: number;
  durationMs?: number;
  result?: unknown;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
    cost?: number;
  };
  runId?: string;
}

export interface WorkflowDisplay {
  update(snapshot: WorkflowSnapshot): void;
  complete(snapshot: WorkflowSnapshot): void;
  clear(): void;
}

export interface WorkflowDisplayOptions {
  key?: string;
  placement?: "aboveEditor" | "belowEditor";
  maxAgents?: number;
  maxLogs?: number;
  showStatus?: boolean;
  showResultPreviews?: boolean;
}

export function createWorkflowSnapshot(meta: WorkflowMeta): WorkflowSnapshot {
  return {
    name: meta.name,
    description: meta.description,
    phases: meta.phases?.map((phase) => phase.title) ?? [],
    logs: [],
    agents: [],
    agentCount: 0,
    runningCount: 0,
    doneCount: 0,
    errorCount: 0,
  };
}

export function recomputeWorkflowSnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot {
  const runningCount = snapshot.agents.filter((agent) => agent.status === "running").length;
  const doneCount = snapshot.agents.filter((agent) => agent.status === "done").length;
  const errorCount = snapshot.agents.filter((agent) => agent.status === "error").length;
  return { ...snapshot, agentCount: snapshot.agents.length, runningCount, doneCount, errorCount };
}

export function createWidgetWorkflowDisplay(
  ctx: Pick<ExtensionContext, "ui" | "hasUI">,
  options: WorkflowDisplayOptions = {},
): WorkflowDisplay {
  const key = options.key ?? "workflow";
  const placement = options.placement ?? "belowEditor";
  const showStatus = options.showStatus ?? false;

  const render = (snapshot: WorkflowSnapshot, completed = false) => {
    if (!ctx.hasUI) return;
    if (showStatus) ctx.ui.setStatus(key, statusLine(snapshot, completed));
    ctx.ui.setWidget(key, renderWorkflowLines(snapshot, options), { placement });
  };

  return {
    update(snapshot) {
      render(snapshot, false);
    },
    complete(snapshot) {
      render(snapshot, true);
    },
    clear() {
      if (!ctx.hasUI) return;
      if (showStatus) ctx.ui.setStatus(key, undefined);
      ctx.ui.setWidget(key, undefined);
    },
  };
}

export function createToolUpdateWorkflowDisplay(
  onUpdate:
    | ((result: {
        content: Array<{ type: "text"; text: string }>;
        details: WorkflowSnapshot;
      }) => void)
    | undefined,
  ctx?: Pick<ExtensionContext, "ui" | "hasUI">,
  options: WorkflowDisplayOptions & { streamToolUpdates?: boolean } = {},
): WorkflowDisplay {
  const widget = ctx === undefined ? undefined : createWidgetWorkflowDisplay(ctx, options);
  const streamToolUpdates = options.streamToolUpdates ?? ctx?.hasUI !== true;

  const emit = (snapshot: WorkflowSnapshot, completed = false) => {
    if (streamToolUpdates) {
      onUpdate?.({
        content: [{ type: "text", text: renderWorkflowText(snapshot, completed) }],
        details: snapshot,
      });
    }
    if (completed) widget?.complete(snapshot);
    else widget?.update(snapshot);
  };

  return {
    update(snapshot) {
      emit(snapshot, false);
    },
    complete(snapshot) {
      emit(snapshot, true);
    },
    clear() {
      widget?.clear();
    },
  };
}

export function renderWorkflowLines(
  snapshot: WorkflowSnapshot,
  options: WorkflowDisplayOptions = {},
): string[] {
  const maxAgents = options.maxAgents ?? 8;
  const maxLogs = options.maxLogs ?? 2;
  const showResultPreviews = options.showResultPreviews ?? false;
  let state = "";
  if (snapshot.errorCount > 0) {
    state = `, ${snapshot.errorCount} errors`;
  } else if (snapshot.runningCount > 0) {
    state = `, ${snapshot.runningCount} running`;
  }
  // Build header with token info (and cost when the provider reports it)
  const usage = snapshot.tokenUsage;
  const costInfo = usage?.cost === undefined ? "" : ` · $${usage.cost.toFixed(4)}`;
  const tokenInfo =
    usage === undefined ? "" : ` · ${usage.total.toLocaleString()} tokens${costInfo}`;
  const lines = [
    `◆ Workflow: ${snapshot.name} (${snapshot.doneCount}/${snapshot.agentCount} done${state}${tokenInfo})`,
  ];

  const phaseNames =
    snapshot.phases.length > 0
      ? snapshot.phases
      : unique(
          snapshot.agents.flatMap((agent) => (agent.phase === undefined ? [] : [agent.phase])),
        );
  const rendered = new Set<WorkflowAgentSnapshot>();

  for (const phase of phaseNames) {
    const agents = snapshot.agents.filter((agent) => agent.phase === phase);
    for (const agent of agents) rendered.add(agent);
    const done = agents.filter((agent) => agent.status === "done").length;
    const running = agents.filter((agent) => agent.status === "running").length;
    const errors = agents.filter((agent) => agent.status === "error").length;
    const skipped = agents.filter((agent) => agent.status === "skipped").length;
    const complete = agents.length > 0 && done + errors + skipped === agents.length;
    let marker = " ";
    if (running > 0 || (!complete && snapshot.currentPhase === phase)) {
      marker = "▶";
    } else if (complete) {
      marker = "✓";
    }
    lines.push(
      `  ${marker} ${phase} ${done}/${agents.length}${running > 0 ? ` · ${running} running` : ""}${errors > 0 ? ` · ${errors} errors` : ""}${skipped > 0 ? ` · ${skipped} skipped` : ""}`,
    );

    const visibleAgents = agents.slice(-maxAgents);
    for (const agent of visibleAgents) {
      const order = `#${agent.id}`;
      const result =
        showResultPreviews && agent.resultPreview !== undefined ? ` — ${agent.resultPreview}` : "";
      const agentTokens =
        agent.tokens === undefined ? "" : ` [${agent.tokens.toLocaleString()} tok]`;
      const activity =
        agent.status === "running" && agent.activity !== undefined ? ` · ${agent.activity}` : "";
      lines.push(
        `    ${order} ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${agentTokens}${activity}${result}`,
      );
    }
    if (agents.length > visibleAgents.length)
      lines.push(`    … ${agents.length - visibleAgents.length} earlier agents`);
  }

  const unphased = snapshot.agents.filter((agent) => !rendered.has(agent));
  if (unphased.length > 0) {
    lines.push("  Unphased");
    for (const agent of unphased.slice(-maxAgents)) {
      const result =
        showResultPreviews && agent.resultPreview !== undefined ? ` — ${agent.resultPreview}` : "";
      const agentTokens =
        agent.tokens === undefined ? "" : ` [${agent.tokens.toLocaleString()} tok]`;
      const activity =
        agent.status === "running" && agent.activity !== undefined ? ` · ${agent.activity}` : "";
      lines.push(
        `    #${agent.id} ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${agentTokens}${activity}${result}`,
      );
    }
  }

  for (const log of snapshot.logs.slice(-maxLogs)) lines.push(`  log: ${log}`);

  return lines;
}

export function renderWorkflowText(snapshot: WorkflowSnapshot, completed = false): string {
  const header = completed ? "Workflow completed" : "Workflow running";
  return [header, ...renderWorkflowLines(snapshot)].join("\n");
}

function statusLine(snapshot: WorkflowSnapshot, completed: boolean): string {
  if (completed) return `workflow ✓ ${snapshot.name}: ${snapshot.doneCount}/${snapshot.agentCount}`;
  if (snapshot.runningCount > 0)
    return `workflow ${snapshot.name}: ${snapshot.runningCount} running, ${snapshot.doneCount}/${snapshot.agentCount} done`;
  return `workflow ${snapshot.name}: ${snapshot.doneCount}/${snapshot.agentCount} done`;
}

function statusIcon(status: WorkflowAgentStatus): string {
  switch (status) {
    case "queued":
      return "○";
    case "running":
      return "●";
    case "done":
      return "✓";
    case "error":
      return "✗";
    case "skipped":
      return "-";
  }
  return "?";
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function shorten(value: string, max: number): string {
  const text = value.replaceAll(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function preview(value: unknown, max = 80): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
