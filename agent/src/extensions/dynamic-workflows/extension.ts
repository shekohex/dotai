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
  registerBuiltinWorkflows(pi, { cwd });
  registerAllSavedWorkflows(pi, cwd, storage);
  // Deliver a background run's result into the conversation when it finishes.
  installResultDelivery(pi, manager);
  installWorkflowInputHooks(pi, getWorkflowModeState());

  pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
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
