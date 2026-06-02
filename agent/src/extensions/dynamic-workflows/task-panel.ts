/**
 * Background-run UX, mirroring Claude Code: - A live task panel below the input lists in-progress
 * runs while you keep working. It is informational; run /workflows to open the full navigator. -
 * When a background run finishes, its result is delivered back into the conversation so the paused
 * task continues with the outcome.
 */

import type { ExtensionAPI, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { renderWorkflowLines, type WorkflowSnapshot } from "./display.js";
import type { ManagedRun, WorkflowManager } from "./workflow-manager.js";
import type { WorkflowStorage } from "./workflow-saved.js";

const deliveryInstalledManagers = new WeakSet<WorkflowManager>();

const RUN_EVENTS = [
  "agentStart",
  "agentEnd",
  "phase",
  "log",
  "complete",
  "error",
  "stopped",
  "paused",
  "resumed",
];

export interface TaskPanelOptions {
  storage?: WorkflowStorage;
  cwd?: string;
}

function deliverText(run: ManagedRun): string {
  const r = run.result?.result;
  const body = hasStringReport(r) ? r.report : JSON.stringify(run.result?.result, null, 2);
  const tokens = run.result?.tokenUsage
    ? ` · ${run.result.tokenUsage.total.toLocaleString()} tokens`
    : "";
  const agents = run.result?.agentCount ?? run.snapshot.agentCount;
  return [
    `✓ Background workflow "${run.snapshot.name}" finished (${agents} agents${tokens}).`,
    "Continue helping the user based on this result.",
    "",
    body,
  ].join("\n");
}

function hasStringReport(value: unknown): value is { report: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "report" in value &&
    typeof value.report === "string" &&
    value.report.trim().length > 0
  );
}

/*
 * When a background run finishes (or fails), deliver its result back into the conversation AND
 * continue the turn so the assistant can act on it — without blocking the user meanwhile:
 *
 * - `triggerTurn: true` starts a fresh turn when the agent is idle, feeding the result to the model
 *   so the paused conversation continues.
 * - `deliverAs: "followUp"` means that if the user is busy in another turn, the result is queued and
 *   picked up after that turn finishes — never interrupting.
 *
 * Set up once per extension; idempotent via an internal guard.
 */
export function installResultDelivery(pi: ExtensionAPI, manager: WorkflowManager): void {
  if (deliveryInstalledManagers.has(manager)) return;
  deliveryInstalledManagers.add(manager);

  const deliver = (content: string) => {
    pi.sendMessage(
      { customType: "workflow-result", content, display: true },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  };

  manager.on("complete", ({ runId }: { runId: string }) => {
    const run = manager.getRun(runId);
    // Only background/resumed runs are delivered: a foreground (sync) run already
    // returns its result inline as the tool result, so re-delivering would dup it.
    if (run?.background === true) deliver(deliverText(run));
  });
  manager.on("error", ({ runId, error }: { runId: string; error?: { message?: string } }) => {
    if (manager.getRun(runId)?.background !== true) return;
    deliver(`✗ Background workflow ${runId} failed: ${error?.message ?? "unknown error"}`);
  });
}

function renderPanel(manager: WorkflowManager, theme: Theme): string[] {
  const active = manager.listRuns().filter((r) => r.status === "running" || r.status === "paused");
  if (active.length === 0) return [];
  const blocks = active.flatMap((r, index) => {
    const live = manager.getRun(r.runId);
    const snapshot = normalizeWorkflowSnapshot(live?.snapshot ?? persistedRunToSnapshot(r));
    const lines = renderWorkflowLines(snapshot, {
      maxAgents: 3,
      maxLogs: 0,
      showResultPreviews: false,
    });
    const status = r.status === "paused" ? theme.fg("warning", "paused") : undefined;
    const rendered = status === undefined ? lines : [theme.fg("warning", `⏸ ${status}`), ...lines];
    return index === 0 ? rendered : ["", ...rendered];
  });
  const hint = theme.fg("dim", "  run /workflows to open");
  return [theme.bold(`Workflows running (${active.length}):`), ...blocks, hint];
}

function normalizeWorkflowSnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot {
  const agents = snapshot.agents ?? [];
  const normalizedAgents = agents.map((agent) => ({
    ...agent,
    label: agent.label ?? `agent ${agent.id}`,
    prompt: agent.prompt ?? "",
  }));
  return {
    ...snapshot,
    phases: snapshot.phases ?? [],
    logs: snapshot.logs ?? [],
    agents: normalizedAgents,
    agentCount: snapshot.agentCount ?? normalizedAgents.length,
    runningCount:
      snapshot.runningCount ??
      normalizedAgents.filter((agent) => agent.status === "running").length,
    doneCount:
      snapshot.doneCount ?? normalizedAgents.filter((agent) => agent.status === "done").length,
    errorCount:
      snapshot.errorCount ?? normalizedAgents.filter((agent) => agent.status === "error").length,
  };
}

function persistedRunToSnapshot(
  run: ReturnType<WorkflowManager["listRuns"]>[number],
): WorkflowSnapshot {
  return {
    name: run.workflowName,
    phases: run.phases,
    currentPhase: run.currentPhase,
    logs: run.logs,
    agents: run.agents.map((agent) => ({
      id: agent.id,
      label: agent.label ?? `agent ${agent.id}`,
      phase: agent.phase,
      prompt: agent.prompt ?? "",
      status: agent.status,
      error: agent.error,
      model: agent.model,
      resultPreview: agent.result === undefined ? undefined : stringifyResult(agent.result),
    })),
    agentCount: run.agents.length,
    runningCount: run.agents.filter((agent) => agent.status === "running").length,
    doneCount: run.agents.filter((agent) => agent.status === "done").length,
    errorCount: run.agents.filter((agent) => agent.status === "error").length,
    durationMs: run.durationMs,
    tokenUsage: run.tokenUsage,
    runId: run.runId,
  };
}

function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result;
  return JSON.stringify(result);
}

/*
 * Install the live "workflows running" panel below the editor. Re-rendered on every manager event.
 * Informational only — the user opens the navigator with /workflows. (`_pi`/`_opts` are kept for
 * signature stability.)
 */
export function installTaskPanel(
  _pi: ExtensionAPI,
  manager: WorkflowManager,
  ui: ExtensionUIContext,
  _opts: TaskPanelOptions = {},
): void {
  ui.setWidget(
    "workflow-tasks",
    (tui: TUI, theme: Theme) => {
      const onEvent = () => {
        tui.requestRender();
      };
      for (const ev of RUN_EVENTS) manager.on(ev, onEvent);
      // Purely informational: it lists running runs and re-renders on events. To
      // open the navigator, the user runs /workflows (the panel takes no input).
      const comp: Component & { dispose?(): void } = {
        render: () => renderPanel(manager, theme),
        invalidate: () => {},
        dispose: () => {
          for (const ev of RUN_EVENTS) manager.off(ev, onEvent);
        },
      };
      return comp;
    },
    { placement: "belowEditor" },
  );
}
