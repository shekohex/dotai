/**
 * Plannotator Pi Extension — File-based plan mode with visual browser review.
 *
 * During planning the agent writes any markdown file anywhere inside cwd and calls submit_plan with
 * the path. The user reviews in the browser UI and can approve, deny with annotations, or request
 * changes.
 *
 * Features:
 *
 * - /plannotator command to toggle
 * - --plan flag to start in planning mode
 * - Bash unrestricted during planning (prompt-guided)
 * - Writes restricted to markdown files inside cwd during planning
 * - Submit_plan tool with browser-based visual approval
 * - Browser-reviewed plan approval before execution
 * - /plannotator-review command for code review
 * - /plannotator-annotate command for markdown annotation
 */

import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPlannotatorEventListeners } from "./plannotator-events.js";
import { registerCurrentPiSession } from "./current-pi-session.js";
import { isPlanWritePathAllowed, type Phase } from "./tool-scope.js";
import {
  createPlannotatorAnnotateHandler,
  createPlannotatorArchiveHandler,
  createPlannotatorLastHandler,
  createPlannotatorReviewHandler,
  registerPlanSubmitTool,
} from "./plannotator-command-handlers.js";
import { type SavedPhaseState } from "./plannotator-support.js";
import { registerPlannotatorSessionHooks } from "./plannotator-session-hooks.js";
import { createPlannotatorPhaseRuntime } from "./plannotator-phase-runtime.js";

type PlannotatorCommandHandler = (
  args: string,
  ctx: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"] extends (
    args: string,
    ctx: infer TCtx,
  ) => unknown
    ? TCtx
    : never,
) => void | Promise<void>;

type PlannotatorSubcommand = {
  value: string;
  description: string;
  run: PlannotatorCommandHandler;
};

function createStatusHandler(args: {
  getPhase: () => Phase;
  getLastSubmittedPath: () => string | null;
}): PlannotatorCommandHandler {
  return (_commandArgs, ctx) => {
    const parts = [`Phase: ${args.getPhase()}`];
    const lastSubmittedPath = args.getLastSubmittedPath();
    if (lastSubmittedPath !== null && lastSubmittedPath.length > 0) {
      parts.push(`Plan file: ${lastSubmittedPath}`);
    }
    ctx.ui.notify(parts.join("\n"), "info");
  };
}

function getPlannotatorArgumentCompletions(
  subcommands: readonly PlannotatorSubcommand[],
  prefix: string,
): AutocompleteItem[] | null {
  const items: AutocompleteItem[] = subcommands.map((item) => ({
    value: item.value,
    label: item.value,
    description: item.description,
  }));
  const trimmed = prefix.trim();
  if (trimmed.length === 0) {
    return items;
  }
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length <= 1 && !prefix.endsWith(" ")) {
    const token = tokens[0] ?? "";
    return items.filter((item) => item.value.startsWith(token));
  }
  return null;
}

function createPlannotatorSubcommands(args: {
  pi: ExtensionAPI;
  currentPiSession: ReturnType<typeof registerCurrentPiSession>;
  phaseRuntime: ReturnType<typeof createPlannotatorPhaseRuntime>;
  getPhase: () => Phase;
  getLastSubmittedPath: () => string | null;
}): readonly PlannotatorSubcommand[] {
  return [
    {
      value: "toggle",
      description: "Toggle plannotator planning mode",
      run: async (_commandArgs, ctx) => {
        await args.phaseRuntime.togglePlanMode(ctx);
      },
    },
    {
      value: "status",
      description: "Show plannotator status",
      run: createStatusHandler({
        getPhase: args.getPhase,
        getLastSubmittedPath: args.getLastSubmittedPath,
      }),
    },
    {
      value: "review",
      description:
        "Open interactive code review for current changes or a PR URL; pass --git to force Git in JJ workspaces",
      run: createPlannotatorReviewHandler({ pi: args.pi, currentPiSession: args.currentPiSession }),
    },
    {
      value: "annotate",
      description: "Open markdown file or folder in annotation UI",
      run: createPlannotatorAnnotateHandler({
        pi: args.pi,
        currentPiSession: args.currentPiSession,
      }),
    },
    {
      value: "last",
      description: "Annotate last assistant message",
      run: createPlannotatorLastHandler({
        pi: args.pi,
        currentPiSession: args.currentPiSession,
      }),
    },
    {
      value: "archive",
      description: "Browse saved plan decisions",
      run: createPlannotatorArchiveHandler(),
    },
  ] as const;
}

export default function plannotator(pi: ExtensionAPI): void {
  const currentPiSession = registerCurrentPiSession(pi);
  let phase: Phase = "idle";
  registerPlannotatorEventListeners(pi);
  let lastSubmittedPath: string | null = null;
  let savedState: SavedPhaseState | null = null;
  let justApprovedPlan = false;

  // ── Flags ────────────────────────────────────────────────────────────

  pi.registerFlag("plan", {
    description: "Start in plan mode (restricted exploration and planning)",
    type: "boolean",
    default: false,
  });

  // ── Helpers ──────────────────────────────────────────────────────────

  const phaseRuntime = createPlannotatorPhaseRuntime({
    pi,
    getPhase: () => phase,
    setPhase: (nextPhase) => {
      phase = nextPhase;
    },
    getLastSubmittedPath: () => lastSubmittedPath,
    setLastSubmittedPath: (nextPath) => {
      lastSubmittedPath = nextPath;
    },
    getSavedState: () => savedState,
    setSavedState: (nextState) => {
      savedState = nextState;
    },
  });

  const plannotatorSubcommands = createPlannotatorSubcommands({
    pi,
    currentPiSession,
    phaseRuntime,
    getPhase: () => phase,
    getLastSubmittedPath: () => lastSubmittedPath,
  });

  // ── Commands & Shortcuts ─────────────────────────────────────────────

  pi.registerCommand("plannotator", {
    description: "Plannotator tools: /plannotator [toggle|status|review|annotate|last|archive]",
    getArgumentCompletions: (prefix) =>
      getPlannotatorArgumentCompletions(plannotatorSubcommands, prefix),
    handler: async (args, ctx) => {
      const trimmedArgs = args.trim();
      const tokens = trimmedArgs.split(/\s+/).filter(Boolean);
      const subcommand = tokens[0] ?? "toggle";
      const command = plannotatorSubcommands.find((item) => item.value === subcommand);
      if (command === undefined) {
        ctx.ui.notify(
          `Unknown plannotator subcommand: ${subcommand}. Use one of: ${plannotatorSubcommands.map((item) => item.value).join(", ")}`,
          "error",
        );
        return;
      }
      const rest = tokens.slice(1).join(" ");
      await command.run(rest, ctx);
    },
  });

  // ── submit_plan Tool ────────────────────────────────────

  registerPlanSubmitTool({
    pi,
    getPhase: () => phase,
    setPhase: (nextPhase) => {
      phase = nextPhase;
    },
    getLastSubmittedPath: () => lastSubmittedPath,
    setLastSubmittedPath: (nextPath) => {
      lastSubmittedPath = nextPath;
    },
    persistState: phaseRuntime.persistState,
    applyPhaseConfig: phaseRuntime.applyPhaseConfig,
    setJustApprovedPlan: (value) => {
      justApprovedPlan = value;
    },
  });

  registerPlannotatorSessionHooks({
    pi,
    currentPiSession,
    getPhase: () => phase,
    setPhase: (nextPhase) => {
      phase = nextPhase;
    },
    getLastSubmittedPath: () => lastSubmittedPath,
    setLastSubmittedPath: (nextPath) => {
      lastSubmittedPath = nextPath;
    },
    getSavedState: () => savedState,
    setSavedState: (nextState) => {
      savedState = nextState;
    },
    getJustApprovedPlan: () => justApprovedPlan,
    setJustApprovedPlan: (value) => {
      justApprovedPlan = value;
    },
    restoreSavedState: phaseRuntime.restoreSavedState,
    applyPhaseConfig: phaseRuntime.applyPhaseConfig,
    persistState: phaseRuntime.persistState,
    updateStatus: phaseRuntime.updateStatus,
    updateWidget: phaseRuntime.updateWidget,
    isPlanWritePathAllowed: (path, cwd) => isPlanWritePathAllowed(path, cwd),
  });
}
