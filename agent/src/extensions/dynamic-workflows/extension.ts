import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createToolStateEntry,
  readToolState,
  TOOL_STATE_ENTRY_TYPE,
} from "../../utils/tool-state.js";
import {
  createWorkflowStorage,
  createWorkflowTool,
  getWorkflowCommandCompletions,
  handleWorkflowCommand,
  getWorkflowModeState,
  installResultDelivery,
  installWorkflowInputHooks,
  isConversationStart,
  registerAllSavedWorkflows,
  registerBuiltinWorkflows,
  registerWorkflowCommands,
  setWorkflowModeAvailability,
  WORKFLOW_PROGRESS_EVENT,
  WorkflowManager,
} from "./index.js";

const WORKFLOW_TOOL_NAME = "workflow";
function activateWorkflowTool(pi: ExtensionAPI): void {
  const active = new Set([...pi.getActiveTools(), WORKFLOW_TOOL_NAME]);
  pi.setActiveTools(Array.from(active).toSorted((left, right) => left.localeCompare(right)));
}

function deactivateWorkflowTool(pi: ExtensionAPI): void {
  pi.setActiveTools(pi.getActiveTools().filter((toolName) => toolName !== WORKFLOW_TOOL_NAME));
}

export default function extension(pi: ExtensionAPI) {
  // Single manager/storage shared by the workflow tool and the /workflows command,
  // so background runs started by the tool are reachable from the command.
  const cwd = process.cwd();
  const storage = createWorkflowStorage(cwd);
  const manager = new WorkflowManager({
    cwd,
    pi,
    loadSavedWorkflow: (name) => storage.load(name)?.script,
  });

  const workflowTool = createWorkflowTool({ cwd, pi, manager, storage });
  pi.registerTool(workflowTool);
  const setWorkflowStatusContext = installWorkflowStatusEmitter(pi, manager);
  let workflowToolEnabled = false;
  const persistWorkflowToolState = (): void => {
    pi.appendEntry(
      TOOL_STATE_ENTRY_TYPE,
      createToolStateEntry(WORKFLOW_TOOL_NAME, workflowToolEnabled),
    );
  };
  const setWorkflowToolEnabled = (enabled: boolean): void => {
    workflowToolEnabled = enabled;
    if (enabled) activateWorkflowTool(pi);
    else deactivateWorkflowTool(pi);
    setWorkflowModeAvailability(getWorkflowModeState(), {
      conversationEmpty: getWorkflowModeState().conversationEmpty,
      toolEnabled: workflowToolEnabled,
    });
  };
  pi.registerCommand("workflow", {
    description:
      "Enable workflow tool or manage workflow runs. Usage: /workflow [on|off|list|status|watch|stop|pause|resume|rm|save]",
    getArgumentCompletions(prefix) {
      const trimmed = prefix.trim();
      const toggle = [
        { value: "on", label: "on", description: "Enable workflow tool for this session" },
        { value: "off", label: "off", description: "Disable workflow tool for this session" },
      ].filter((item) => item.value.startsWith(trimmed));
      return [...toggle, ...(getWorkflowCommandCompletions(prefix, manager) ?? [])];
    },
    async handler(args, ctx) {
      const trimmed = args.trim();
      if (trimmed === "on" || trimmed === "") {
        setWorkflowToolEnabled(true);
        persistWorkflowToolState();
        ctx.ui.notify("Workflow tool enabled.", "info");
        return;
      }
      if (trimmed === "off") {
        setWorkflowToolEnabled(false);
        persistWorkflowToolState();
        ctx.ui.notify("Workflow tool disabled.", "info");
        return;
      }
      setWorkflowToolEnabled(true);
      persistWorkflowToolState();
      await handleWorkflowCommand({
        pi,
        manager,
        opts: { storage, cwd },
        parts: trimmed.split(/\s+/).filter(Boolean),
        ctx,
      });
    },
  });
  registerWorkflowCommands(pi, manager, { storage, cwd });
  registerBuiltinWorkflows(pi, { cwd, manager });
  registerAllSavedWorkflows(pi, cwd, storage, manager);
  // Deliver a background run's result into the conversation when it finishes.
  installResultDelivery(pi, manager);
  installWorkflowInputHooks(pi, getWorkflowModeState());

  pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
    setWorkflowStatusContext(ctx);
    const restored = readToolState(ctx.sessionManager.getBranch(), WORKFLOW_TOOL_NAME);
    const conversationEmpty = isConversationStart(ctx);
    const enabled = restored === true || (restored === null && conversationEmpty);
    setWorkflowModeAvailability(getWorkflowModeState(), {
      conversationEmpty,
      toolEnabled: enabled,
    });
    setWorkflowToolEnabled(enabled);
    manager.setMainModel(ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
    manager.setExtensionContext(ctx);
  });
  pi.on("before_agent_start", () => {
    if (!workflowToolEnabled) deactivateWorkflowTool(pi);
  });
  pi.on("session_tree", (_event: unknown, ctx: ExtensionContext) => {
    setWorkflowStatusContext(ctx);
    const restored = readToolState(ctx.sessionManager.getBranch(), WORKFLOW_TOOL_NAME);
    const conversationEmpty = isConversationStart(ctx);
    const enabled = restored === true || (restored === null && conversationEmpty);
    setWorkflowModeAvailability(getWorkflowModeState(), {
      conversationEmpty,
      toolEnabled: enabled,
    });
    setWorkflowToolEnabled(enabled);
  });
}

function installWorkflowStatusEmitter(
  pi: ExtensionAPI,
  manager: WorkflowManager,
): (ctx: ExtensionContext) => void {
  let currentSessionContext: { sessionId: string; cwd: string } | null = null;
  const activeWorkflowStarts = new Map<string, number>();
  const updateWorkflowStatus = (): void => {
    if (currentSessionContext === null) return;
    const activeRuns = [...activeWorkflowStarts.keys()]
      .map((runId) => manager.getRun(runId))
      .filter(
        (run) =>
          run !== undefined && run.status === "running" && !isGoalWorkflowName(run.snapshot.name),
      );
    if (activeRuns.length === 0) {
      pi.events.emit(WORKFLOW_PROGRESS_EVENT, {
        status: "clear",
        sessionId: currentSessionContext.sessionId,
        cwd: currentSessionContext.cwd,
      });
      return;
    }
    const run = activeRuns.at(-1);
    if (run === undefined) return;
    const startedAt = activeWorkflowStarts.get(run.runId) ?? run.startedAt.getTime();
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    pi.events.emit(WORKFLOW_PROGRESS_EVENT, {
      status: "active",
      sessionId: currentSessionContext.sessionId,
      cwd: currentSessionContext.cwd,
      runId: run.runId,
      workflowName: run.snapshot.name,
      elapsedSeconds,
      phase: run.snapshot.currentPhase,
    });
  };
  const workflowStatusTimer = setInterval(updateWorkflowStatus, 1_000);
  workflowStatusTimer.unref?.();
  const settleWorkflowStatus = (event: { runId?: string }): void => {
    if (event.runId !== undefined) activeWorkflowStarts.delete(event.runId);
    updateWorkflowStatus();
  };
  manager.on("started", (event: { runId: string; workflowName: string }) => {
    if (!isGoalWorkflowName(event.workflowName)) activeWorkflowStarts.set(event.runId, Date.now());
    updateWorkflowStatus();
  });
  for (const eventName of ["phase", "agentStart", "agentEnd", "log"] as const) {
    manager.on(eventName, updateWorkflowStatus);
  }
  for (const eventName of ["complete", "error", "stopped", "paused"] as const) {
    manager.on(eventName, settleWorkflowStatus);
  }
  return (ctx) => {
    currentSessionContext = { sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd };
    updateWorkflowStatus();
  };
}

function isGoalWorkflowName(name: string): boolean {
  return name === "goal" || name.startsWith("goal-");
}
