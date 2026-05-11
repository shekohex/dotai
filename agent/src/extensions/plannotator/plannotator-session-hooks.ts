import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { hasPlanBrowserHtml } from "./plannotator-events.js";
import {
  getPlanReviewAvailabilityWarning,
  type PersistedPlannotatorState,
  type SavedPhaseState,
} from "./plannotator-support.js";
import {
  getApplyPatchPaths,
  PLAN_SUBMIT_TOOL,
  stripPlanningOnlyTools,
  type Phase,
} from "./tool-scope.js";

type SessionEntryData = { data?: PersistedPlannotatorState };
type ContextTextPart = { type: string; text?: string };
type ContextMessage = { customType?: string; role?: string; content?: unknown };

const ApplyPatchInputSchema = Type.Object({
  patchText: Type.String(),
});

function isPersistedStateEntry(value: unknown): value is SessionEntryData {
  return typeof value === "object" && value !== null && "data" in value;
}

function isContextTextPart(value: unknown): value is ContextTextPart {
  return typeof value === "object" && value !== null && "type" in value;
}

function isContextMessage(value: unknown): value is ContextMessage {
  return typeof value === "object" && value !== null;
}

function hasPlannotatorContextMarker(content: unknown): boolean {
  if (typeof content === "string") {
    return content.includes("[PLANNOTATOR -");
  }
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some(
    (part) =>
      isContextTextPart(part) &&
      part.type === "text" &&
      typeof part.text === "string" &&
      part.text.includes("[PLANNOTATOR -"),
  );
}

function shouldKeepContextMessage(message: unknown): boolean {
  if (!isContextMessage(message)) return true;
  if (message.customType === "plannotator-context") return false;
  if (message.role !== "user") return true;
  return !hasPlannotatorContextMarker(message.content);
}

function getPlanningSystemMessage(planToolName: string): string {
  return `[PLANNOTATOR - PLANNING PHASE]
You are in plan mode. You MUST NOT make any changes to codebase. During planning you may only write or edit markdown files (.md, .mdx) inside working directory.

Available tools: read, bash, write (markdown only), edit (markdown only), ${planToolName}

Do not run destructive bash commands (rm, git push, npm install, etc.). Focus on reading and exploring codebase. Use bash for grep/find/ls style discovery. Web fetching (curl, wget) is fine.

## Iterative Planning Workflow

You are pair-planning with user. Explore code to build context, then write findings into markdown plan file as you go. Plan starts as rough skeleton and gradually becomes final plan.

### Picking plan file

Choose descriptive filename for plan. Convention: \`PLAN.md\` at repo root for single focused plan, or \`plans/<short-name>.md\` for projects that keep multiple plans. Reuse same filename across revisions of same plan.

### Loop

Repeat this cycle until plan is complete:

1. **Explore** — Use read and bash to understand codebase. Actively search for existing functions, utilities, and patterns that can be reused.
2. **Update plan file** — After each discovery, immediately capture what you learned in plan. Use write for initial draft, then edit for subsequent updates.
3. **Ask user** — When you hit ambiguity or decision you cannot resolve from code alone, ask. Then go back to step 1.

### First Turn

Start by quickly scanning key files to form initial understanding of task scope. Then write skeleton plan and ask first round of questions. Do not explore exhaustively before engaging user.

### Asking Good Questions

- Never ask what you could find out by reading code.
- Batch related questions together.
- Focus on things only user can answer: requirements, preferences, tradeoffs, edge-case priorities.
- Scale depth to task.

### Plan File Structure

Your plan file should use markdown with clear sections:
- **Context**
- **Approach**
- **Files to modify**
- **Reuse**
- **Steps**
- **Verification**

### When to Submit

Call ${planToolName} with path to plan file when ready.

### Revising After Feedback

When user denies plan with feedback:
1. Read current plan file.
2. Make targeted edits.
3. Call ${planToolName} again with same filePath.

### Ending Your Turn

Only end by either asking user a question or calling ${planToolName}.`;
}

function findPersistedStateEntry(entries: unknown[]): SessionEntryData | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isPersistedStateEntry(entry)) continue;
    const data = entry.data;
    if (data !== undefined) return entry;
  }
  return undefined;
}

export function registerPlannotatorSessionHooks(args: {
  pi: ExtensionAPI;
  currentPiSession: { update: (ctx: ExtensionContext) => void; clear: () => void };
  getPhase: () => Phase;
  setPhase: (phase: Phase) => void;
  getLastSubmittedPath: () => string | null;
  setLastSubmittedPath: (path: string | null) => void;
  getSavedState: () => SavedPhaseState | null;
  setSavedState: (state: SavedPhaseState | null) => void;
  getJustApprovedPlan: () => boolean;
  setJustApprovedPlan: (value: boolean) => void;
  restoreSavedState: (ctx: ExtensionContext) => Promise<void>;
  applyPhaseConfig: (
    ctx: ExtensionContext,
    opts?: { restoreSavedState?: boolean },
  ) => Promise<void>;
  persistState: () => void;
  updateStatus: (ctx: ExtensionContext) => void;
  updateWidget: (ctx: ExtensionContext) => void;
  isPlanWritePathAllowed: (path: string, cwd: string) => boolean;
}) {
  registerSessionTrackingHooks(args);
  registerPlanningHooks(args);
  registerContextHooks(args);
  registerSessionRestoreHook(args);
}

function registerSessionTrackingHooks(
  args: Parameters<typeof registerPlannotatorSessionHooks>[0],
): void {
  args.pi.on("session_start", (_event, ctx) => {
    args.currentPiSession.update(ctx);
  });

  args.pi.on("session_shutdown", () => {
    args.currentPiSession.clear();
  });
}

function registerPlanningHooks(args: Parameters<typeof registerPlannotatorSessionHooks>[0]): void {
  function blockWritePath(path: string, cwd: string): { block: true; reason: string } | undefined {
    if (args.isPlanWritePathAllowed(path, cwd)) return undefined;
    return {
      block: true,
      reason: `Plannotator: during planning, writes are limited to markdown files (.md, .mdx) inside working directory. Blocked: ${path}`,
    };
  }

  function blockEditPath(path: string, cwd: string): { block: true; reason: string } | undefined {
    if (args.isPlanWritePathAllowed(path, cwd)) return undefined;
    return {
      block: true,
      reason: `Plannotator: during planning, edits are limited to markdown files (.md, .mdx) inside working directory. Blocked: ${path}`,
    };
  }

  function blockApplyPatchInput(
    input: unknown,
    cwd: string,
  ): { block: true; reason: string } | undefined {
    if (!Value.Check(ApplyPatchInputSchema, input)) {
      return {
        block: true,
        reason:
          "Plannotator: during planning, apply_patch requires patchText and may only touch markdown files (.md, .mdx) inside working directory.",
      };
    }
    const patchInput = Value.Parse(ApplyPatchInputSchema, input);
    const paths = getApplyPatchPaths(patchInput.patchText);
    if (paths.length === 0) {
      return {
        block: true,
        reason:
          "Plannotator: during planning, apply_patch must target markdown files (.md, .mdx) inside working directory.",
      };
    }
    const blockedPath = paths.find((path) => !args.isPlanWritePathAllowed(path, cwd));
    if (blockedPath === undefined) return undefined;
    return {
      block: true,
      reason: `Plannotator: during planning, apply_patch is limited to markdown files (.md, .mdx) inside working directory. Blocked: ${blockedPath}`,
    };
  }

  args.pi.on("tool_call", (event, ctx) => {
    let blockResult: { block: true; reason: string } | undefined;
    if (args.getPhase() === "planning") {
      if (isToolCallEventType("write", event)) {
        blockResult = blockWritePath(event.input.path, ctx.cwd);
      } else if (isToolCallEventType("edit", event)) {
        blockResult = blockEditPath(event.input.path, ctx.cwd);
      } else if (event.type === "tool_call" && event.toolName === "apply_patch") {
        blockResult = blockApplyPatchInput(event.input, ctx.cwd);
      }
    }
    return blockResult;
  });
}

function registerContextHooks(args: Parameters<typeof registerPlannotatorSessionHooks>[0]): void {
  const beforeAgentStartHandler = (
    event: unknown,
    ctx: ExtensionContext,
  ):
    | { systemPrompt: string }
    | { message: { customType: string; content: string; display: boolean } }
    | undefined => {
    void event;
    const phase = args.getPhase();
    const planRef = args.getLastSubmittedPath() ?? "your plan file";
    if (phase === "executing") {
      const lastSubmittedPath = args.getLastSubmittedPath();
      if (lastSubmittedPath !== null && lastSubmittedPath.length > 0) {
        const fullPath = resolve(ctx.cwd, lastSubmittedPath);
        if (!existsSync(fullPath)) {
          args.setPhase("idle");
          args.setLastSubmittedPath(null);
        }
      }
    }

    if (args.getPhase() === "planning") {
      return {
        message: {
          customType: "plannotator-context",
          content: getPlanningSystemMessage(PLAN_SUBMIT_TOOL),
          display: false,
        },
      };
    }

    if (args.getPhase() === "executing") {
      return {
        message: {
          customType: "plannotator-context",
          content: `[PLANNOTATOR - EXECUTING PLAN]\nFull tool access is enabled. Execute approved plan from ${planRef}. Re-read plan file as needed and follow any review notes included with approval.`,
          display: false,
        },
      };
    }
    return undefined;
  };
  args.pi.on("before_agent_start", beforeAgentStartHandler);

  args.pi.on("context", (event) =>
    args.getPhase() === "idle"
      ? {
          messages: event.messages.filter((message) => shouldKeepContextMessage(message)),
        }
      : undefined,
  );

  args.pi.on("agent_end", (_event, _ctx) => {
    if (args.getPhase() === "executing" && args.getJustApprovedPlan()) {
      args.setJustApprovedPlan(false);
      setTimeout(() => {
        args.pi.sendUserMessage("Continue with approved plan.");
      }, 0);
    }
  });
}

function registerSessionRestoreHook(
  args: Parameters<typeof registerPlannotatorSessionHooks>[0],
): void {
  args.pi.on("session_start", async (_event, ctx) => {
    if (args.pi.getFlag("plan") === true) {
      args.setPhase("planning");
    }

    const stateEntry = findPersistedStateEntry(ctx.sessionManager.getEntries());
    if (stateEntry?.data !== undefined) {
      args.setPhase(stateEntry.data.phase);
      args.setLastSubmittedPath(stateEntry.data.lastSubmittedPath ?? args.getLastSubmittedPath());
      args.setSavedState(stateEntry.data.savedState ?? args.getSavedState());
    }

    if (args.getPhase() === "executing") {
      const lastSubmittedPath = args.getLastSubmittedPath();
      if (lastSubmittedPath !== null && lastSubmittedPath.length > 0) {
        if (!existsSync(resolve(ctx.cwd, lastSubmittedPath))) {
          args.setPhase("idle");
          args.setLastSubmittedPath(null);
        }
      } else {
        args.setPhase("idle");
      }
    }

    if (args.getPhase() === "planning") {
      const warning = getPlanReviewAvailabilityWarning({
        hasUI: ctx.hasUI,
        hasPlanHtml: hasPlanBrowserHtml(),
      });
      if (warning !== null) {
        ctx.ui.notify(warning, "warning");
      }
    }

    if (args.getPhase() === "idle") {
      if (args.getSavedState() === null) {
        args.pi.setActiveTools(stripPlanningOnlyTools(args.pi.getActiveTools()));
      } else {
        await args.restoreSavedState(ctx);
        args.setSavedState(null);
      }
    } else {
      await args.applyPhaseConfig(ctx, { restoreSavedState: true });
    }

    args.updateStatus(ctx);
    args.updateWidget(ctx);
    args.persistState();
  });
}
