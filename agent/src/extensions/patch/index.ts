import {
  defineTool,
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { createTextComponent } from "../coreui/tools.js";
import { applyPatchHunks, getQueuePaths, parsePatchExecutionInput } from "./execution.js";
import { getApplyPatchDetails, parseApplyPatchDetails } from "./render-details.js";
import {
  applyCollapsedPatchSummaryToCall,
  formatApplyPatchCall,
  formatApplyPatchSuccess,
  getResultText,
  renderApplyPatchCollapsedSuccess,
  renderApplyPatchError,
  renderApplyPatchExpandedSuccess,
  renderApplyPatchProgress,
  setPatchCallComponent,
  syncPatchRenderState,
  type PatchCallRenderContext,
} from "./render.js";
import {
  isApplyPatchShellCommand,
  sameToolSet,
  shouldUsePatch,
  withFileMutationQueues,
} from "./tool-utils.js";
import type { ApplyPatchDetails, ApplyPatchRenderState } from "./types.js";

const ApplyPatchRenderStateSchema = Type.Object({}, { additionalProperties: true });

function isApplyPatchRenderState(value: unknown): value is ApplyPatchRenderState {
  return Value.Check(ApplyPatchRenderStateSchema, value);
}

const APPLY_PATCH_DESCRIPTION = `Use the \`apply_patch\` tool to edit files. Your patch language is a stripped‑down, file‑oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high‑level envelope:

*** Begin Patch
[ one or more file sections ]
*** End Patch

Within that envelope, you get a sequence of file operations.
You MUST include a header to specify the action you are taking.
Each operation starts with one of three headers:

*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).
*** Delete File: <path> - remove an existing file. Nothing follows.
*** Update File: <path> - patch an existing file in place (optionally with a rename).

Example patch:

\`\`\`
*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch
\`\`\`

It is important to remember:

- You must include a header with your intended action (Add/Delete/Update)
- You must prefix new lines with \`+\` even when creating a new file
`;

const applyPatchParams = Type.Object(
  {
    patchText: Type.String({
      description: "The full patch text that describes all changes to be made",
    }),
  },
  { additionalProperties: false },
);

export const applyPatchTool = defineTool<
  typeof applyPatchParams,
  ApplyPatchDetails,
  ApplyPatchRenderState
>({
  name: "apply_patch",
  label: "patch",
  renderShell: "self",
  description: APPLY_PATCH_DESCRIPTION,
  promptSnippet: `use \`apply_patch\` to edit/patch files`,
  parameters: applyPatchParams,
  execute(_toolCallId, params, _signal, onUpdate, ctx) {
    const { hunks, targets } = parsePatchExecutionInput(params.patchText);
    const queuePaths = getQueuePaths(hunks, ctx);
    return withFileMutationQueues(queuePaths, () => applyPatchHunks(hunks, targets, onUpdate, ctx));
  },
  renderCall(args, theme, context) {
    const state = isApplyPatchRenderState(context.state) ? context.state : {};
    const renderContext: PatchCallRenderContext = {
      isPartial: context.isPartial,
      argsComplete: context.argsComplete,
      expanded: context.expanded,
      isError: context.isError,
      cwd: context.cwd,
      state,
    };

    return setPatchCallComponent(
      state,
      context.lastComponent,
      formatApplyPatchCall(args.patchText, theme, renderContext),
    );
  },
  renderResult(result, options, theme, context) {
    const state = isApplyPatchRenderState(context.state) ? context.state : {};
    syncPatchRenderState(
      { state, invalidate: context.invalidate },
      parseApplyPatchDetails(result.details),
      getResultText(result.content),
    );
    const output = getResultText(result.content);
    const details = getApplyPatchDetails(result.details, context.args.patchText);

    if (context.isError) {
      if (options.expanded) {
        return createTextComponent(
          context.lastComponent,
          renderApplyPatchError(details.targets, output, theme, true),
        );
      }
      return createTextComponent(context.lastComponent, "");
    }

    if (options.isPartial) {
      return createTextComponent(
        context.lastComponent,
        renderApplyPatchProgress(details, theme, options.expanded),
      );
    }

    if (!options.expanded) {
      applyCollapsedPatchSummaryToCall(state, formatApplyPatchSuccess(details, theme, context.cwd));
      return createTextComponent(
        context.lastComponent,
        renderApplyPatchCollapsedSuccess(details, theme),
      );
    }

    return createTextComponent(
      context.lastComponent,
      renderApplyPatchExpandedSuccess(details, theme, context.args.patchText),
    );
  },
});

type PatchToolSyncState = {
  patchMode: boolean;
  savedToolsBeforePatch: string[] | undefined;
};

export default function patchExtension(pi: ExtensionAPI) {
  pi.registerTool(applyPatchTool);
  const state: PatchToolSyncState = { patchMode: false, savedToolsBeforePatch: undefined };
  const syncTools = createPatchToolSynchronizer(pi, state);
  registerPatchToolSyncEvents(pi, syncTools);
  registerApplyPatchCommandBlocker(pi);
}

function createPatchToolSynchronizer(pi: ExtensionAPI, state: PatchToolSyncState) {
  return (ctx: ExtensionContext): void => {
    const activeTools = pi.getActiveTools();
    if (shouldUsePatch(ctx.model?.id)) {
      enablePatchToolSet(pi, state, activeTools);
      return;
    }
    if (state.patchMode) {
      restorePatchToolSet(pi, state, activeTools);
      return;
    }

    removeApplyPatchTool(pi, activeTools);
  };
}

function enablePatchToolSet(
  pi: ExtensionAPI,
  state: PatchToolSyncState,
  activeTools: string[],
): void {
  if (!state.patchMode) {
    state.savedToolsBeforePatch = activeTools.filter((toolName) => toolName !== "apply_patch");
  }

  const nextTools = new Set(activeTools);
  nextTools.delete("edit");
  nextTools.delete("write");
  nextTools.add(applyPatchTool.name);
  const next = Array.from(nextTools);
  if (!sameToolSet(activeTools, next)) {
    pi.setActiveTools(next);
  }
  state.patchMode = true;
}

function restorePatchToolSet(
  pi: ExtensionAPI,
  state: PatchToolSyncState,
  activeTools: string[],
): void {
  const restored = (
    state.savedToolsBeforePatch ?? activeTools.filter((toolName) => toolName !== "apply_patch")
  ).filter((toolName) => toolName !== "apply_patch");
  if (!sameToolSet(activeTools, restored)) {
    pi.setActiveTools(restored);
  }
  state.savedToolsBeforePatch = undefined;
  state.patchMode = false;
}

function removeApplyPatchTool(pi: ExtensionAPI, activeTools: string[]): void {
  if (!activeTools.includes("apply_patch")) {
    return;
  }

  const next = activeTools.filter((toolName) => toolName !== "apply_patch");
  if (!sameToolSet(activeTools, next)) {
    pi.setActiveTools(next);
  }
}

function registerPatchToolSyncEvents(
  pi: ExtensionAPI,
  syncTools: (ctx: ExtensionContext) => void,
): void {
  pi.on("session_start", (_event, ctx) => {
    syncTools(ctx);
  });
  pi.on("model_select", (_event, ctx) => {
    syncTools(ctx);
  });
  pi.on("before_agent_start", (_event, ctx) => {
    syncTools(ctx);
  });
}

function registerApplyPatchCommandBlocker(pi: ExtensionAPI): void {
  pi.on("tool_call", (event) => {
    let blocked: { block: true; reason: string } | undefined;
    if (isToolCallEventType("bash", event)) {
      const command = event.input.command.trim();
      if (!pi.getActiveTools().includes(applyPatchTool.name) && isApplyPatchShellCommand(command)) {
        blocked = {
          block: true,
          reason:
            "`apply_patch` is not active for this model. Use the available file-editing tools instead.",
        };
      }
    }

    return blocked;
  });
}

export { shouldUsePatch };
