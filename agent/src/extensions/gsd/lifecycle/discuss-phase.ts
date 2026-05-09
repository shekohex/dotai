import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { GsdCommandArgs } from "../args.js";
import { buildAssumptionsDraft } from "./discuss-phase-assumptions.js";
import {
  buildAssumptionsPreviewAreas,
  buildDefaultGrayAreas,
  buildGrayAreaAnalysis,
  grayAreasForCheckpoint,
  pickAreaQuestions,
  type GrayArea,
} from "./discuss-phase-gray-areas.js";
import { createTextReplyReader } from "./discuss-phase-text.js";
import { promptInput, promptSelect } from "./discuss-phase-io.js";
import { resolveAssumptionsResearchGaps } from "./discuss-phase-research-gaps.js";
import {
  createEmptyDiscussDraft,
  extractPhaseCanonicalReferences,
  loadPriorDiscussContext,
  readCurrentDiscussArtifacts,
  readDiscussBlockingResumeFile,
  readDiscussCheckpoint,
  readDiscussConfig,
  removeDiscussCheckpoint,
  resolveDiscussMode,
  resolveDiscussRoute,
  scoutDiscussCodebase,
  writeDiscussArtifacts,
  writeDiscussCheckpoint,
  type DiscussMode,
  type DiscussRoute,
} from "../state/discuss.js";
import { ensureCurrentPhaseDir, writeStateFields } from "../state/runtime.js";
import type { DiscussCheckpoint, DiscussDraft } from "../state/schema.js";

function buildPhaseBoundary(phaseNumber: string, phaseName: string): string {
  return `Phase ${phaseNumber}: ${phaseName}`;
}

function appendUnique(items: string[], nextItems: string[]): string[] {
  for (const item of nextItems.map((value) => value.trim()).filter((value) => value.length > 0)) {
    if (!items.includes(item)) {
      items.push(item);
    }
  }
  return items;
}

function hydrateCheckpointSideChannels(checkpoint: DiscussCheckpoint): void {
  checkpoint.canonicalReferences = appendUnique(
    checkpoint.canonicalReferences,
    checkpoint.draft.canonicalReferences.map((item) => item.path),
  );
  checkpoint.deferredIdeas = appendUnique(checkpoint.deferredIdeas, checkpoint.draft.deferredIdeas);
}

function resetAssumptionsDerivedState(checkpoint: DiscussCheckpoint): void {
  checkpoint.draft.implementationDecisions = [];
  checkpoint.draft.existingCodeInsights = checkpoint.draft.existingCodeInsights.filter(
    (item) => item === checkpoint.scoutSummary,
  );
  checkpoint.draft.specificIdeas = [];
  checkpoint.deferredIdeas = checkpoint.deferredIdeas.filter(
    (item) => !item.startsWith("If wrong: "),
  );
  checkpoint.draft.deferredIdeas = checkpoint.draft.deferredIdeas.filter(
    (item) => !item.startsWith("If wrong: "),
  );
  checkpoint.draft.discussionLog = checkpoint.draft.discussionLog.filter(
    (item) => item !== "Assumptions analyzer summary:" && !item.startsWith("- "),
  );
}

function normalizeDraftDecisionIds(draft: DiscussDraft): DiscussDraft {
  draft.implementationDecisions = draft.implementationDecisions.map((decision, index) => ({
    ...decision,
    id: `D-${String(index + 1).padStart(2, "0")}`,
  }));
  return draft;
}

function replaceDecisionForArea(
  draft: DiscussDraft,
  area: string,
  decision: string,
  source: "user" | "auto" | "assumption",
): void {
  const normalizedArea = area.trim().toLowerCase();
  draft.implementationDecisions = draft.implementationDecisions.filter(
    (entry) => entry.area.trim().toLowerCase() !== normalizedArea,
  );
  draft.implementationDecisions.push({ id: "", area, decision, source });
}

function applyAreaAnswer(
  checkpoint: DiscussCheckpoint,
  area: string,
  answer: string,
  source: "user" | "auto",
): void {
  const trimmed = answer.trim();
  if (trimmed.length === 0) {
    return;
  }
  checkpoint.draft.discussionLog.push(`${area}: ${trimmed}`);
  checkpoint.areaSelections[area] ??= [];
  checkpoint.areaSelections[area].push(trimmed);
  if (area === "Canonical references") {
    checkpoint.canonicalReferences = appendUnique(checkpoint.canonicalReferences, [trimmed]);
    checkpoint.draft.canonicalReferences = checkpoint.canonicalReferences.map((path) => ({
      path,
      reason:
        checkpoint.draft.canonicalReferences.find((item) => item.path === path)?.reason ??
        (path.startsWith(".") || path.includes("/") ? "Discuss canonical ref" : "Discuss note"),
    }));
    return;
  }
  if (area === "Risks and deferrals") {
    checkpoint.deferredIdeas = appendUnique(checkpoint.deferredIdeas, [trimmed]);
    checkpoint.draft.deferredIdeas = [...checkpoint.deferredIdeas];
  }
  replaceDecisionForArea(checkpoint.draft, area, trimmed, source);
  normalizeDraftDecisionIds(checkpoint.draft);
}

function buildPendingPrompt(checkpoint: DiscussCheckpoint): string {
  const options =
    checkpoint.promptOptions.length === 0
      ? ""
      : `\n\nOptions:\n${checkpoint.promptOptions.map((item) => `- ${item}`).join("\n")}`;
  return `${checkpoint.pendingPrompt}${options}`;
}

function notifyStop(ctx: ExtensionCommandContext, checkpoint: DiscussCheckpoint): void {
  ctx.ui.notify(buildPendingPrompt(checkpoint), "info");
}

function summarizeExistingContext(checkpoint: DiscussCheckpoint): string {
  const parts: string[] = [];
  if (checkpoint.draft.implementationDecisions.length > 0) {
    parts.push(
      `Current phase context loaded with ${String(checkpoint.draft.implementationDecisions.length)} decision(s).`,
    );
  }
  if (checkpoint.priorContextSummary.trim().length > 0) {
    parts.push(
      `Prior context available. ${checkpoint.priorContextSummary.split(/\r?\n/u)[0] ?? ""}`,
    );
  }
  if (checkpoint.scoutSummary.trim().length > 0) {
    parts.push(`Codebase scout ready. ${checkpoint.scoutSummary.split(/\r?\n/u)[0] ?? ""}`);
  }
  return parts.join(" ").trim();
}

function buildCheckpoint(
  cwd: string,
  current: ReturnType<typeof ensureCurrentPhaseDir>,
  args: GsdCommandArgs,
  route: DiscussRoute,
  mode: DiscussMode,
): DiscussCheckpoint {
  const grayAreas =
    route === "default-discuss" ? buildDefaultGrayAreas() : buildAssumptionsPreviewAreas();
  const priorContextSummary = loadPriorDiscussContext(cwd, current.phase.number);
  const scoutSummary = scoutDiscussCodebase(cwd, current.phase.number);
  const draft =
    (route === "assumptions-preview"
      ? undefined
      : readCurrentDiscussArtifacts(current.phaseDir, current.phaseFilePrefix)) ??
    createEmptyDiscussDraft(buildPhaseBoundary(current.phase.number, current.phase.name));
  if (draft.phaseBoundary.length === 0) {
    draft.phaseBoundary = buildPhaseBoundary(current.phase.number, current.phase.name);
  }
  const existingContextSummary = summarizeExistingContext({
    phase: current.phase.number,
    mode,
    route,
    all: args.all === true,
    auto: args.auto === true,
    chain: args.chain === true,
    text: args.text === true,
    stage: "init",
    pendingPrompt: "",
    promptOptions: [],
    priorContextSummary,
    scoutSummary,
    existingContextSummary: "",
    areaQuestions: {},
    areaSelections: {},
    areasCompleted: [],
    areasRemaining: grayAreas.map((item) => item.area),
    assumptionsAutoReady: false,
    assumptionsResearchGaps: [],
    deferredIdeas: [],
    canonicalReferences: [],
    draft,
  });
  return {
    phase: current.phase.number,
    mode,
    route,
    all: args.all === true,
    auto: args.auto === true,
    chain: args.chain === true,
    text: args.text === true,
    stage: "init",
    pendingPrompt: "Start discuss routing.",
    promptOptions: [],
    priorContextSummary,
    scoutSummary,
    existingContextSummary,
    areaQuestions: {},
    areaSelections: {},
    areasCompleted: [],
    areasRemaining: grayAreas.map((item) => item.area),
    assumptionsAutoReady: false,
    assumptionsResearchGaps: [],
    deferredIdeas: [],
    canonicalReferences: [],
    draft,
  };
}

function syncCanonicalReferences(cwd: string, checkpoint: DiscussCheckpoint): void {
  const references = extractPhaseCanonicalReferences(cwd, checkpoint.phase);
  for (const reference of references) {
    if (!checkpoint.draft.canonicalReferences.some((item) => item.path === reference.path)) {
      checkpoint.draft.canonicalReferences.push(reference);
    }
    if (!checkpoint.canonicalReferences.includes(reference.path)) {
      checkpoint.canonicalReferences.push(reference.path);
    }
  }
}

async function resolveExistingContextStep(
  ctx: ExtensionCommandContext,
  checkpoint: DiscussCheckpoint,
  textReplyReader: { consume: () => string | undefined },
): Promise<"checkpoint" | "continue"> {
  if (checkpoint.stage !== "existing-context") {
    return "continue";
  }
  const existingChoice = await promptSelect(
    ctx,
    checkpoint,
    `Existing context for phase ${checkpoint.phase}`,
    ["Use existing context", "View context summary", "Skip prior context"],
    textReplyReader,
  );
  if (existingChoice === undefined) {
    return "checkpoint";
  }
  checkpoint.draft.discussionLog.push(`Existing context branch: ${existingChoice}`);
  if (existingChoice === "View context summary") {
    checkpoint.draft.discussionLog.push(
      checkpoint.existingContextSummary ?? "No prior context summary.",
    );
  }
  checkpoint.stage = "gray-area-analysis";
  return "continue";
}

async function resolveGrayAreaSelectionStep(
  ctx: ExtensionCommandContext,
  checkpoint: DiscussCheckpoint,
  grayAreaMap: Map<string, GrayArea>,
  textReplyReader: { consume: () => string | undefined },
): Promise<"checkpoint" | "continue"> {
  if (checkpoint.stage !== "gray-area-selection") {
    return "continue";
  }
  const availableAreas = checkpoint.areasRemaining.filter((item) => grayAreaMap.has(item));
  if (availableAreas.length === 0) {
    checkpoint.stage = "final-loop";
    return "continue";
  }
  if (checkpoint.all) {
    checkpoint.activeArea = availableAreas[0];
    const defaultArea = grayAreasForCheckpoint(checkpoint)[0];
    if (checkpoint.activeArea !== undefined) {
      checkpoint.areaQuestions[checkpoint.activeArea] ??= pickAreaQuestions(
        grayAreaMap.get(checkpoint.activeArea) ?? defaultArea,
      );
    }
    checkpoint.stage = "area-question";
    return "continue";
  }
  const selectedArea = await promptSelect(
    ctx,
    checkpoint,
    "Select next gray area",
    checkpoint.auto ? [availableAreas[0] ?? "Implementation approach"] : availableAreas,
    textReplyReader,
  );
  if (selectedArea === undefined) {
    return "checkpoint";
  }
  const defaultArea = grayAreasForCheckpoint(checkpoint)[0];
  checkpoint.activeArea = selectedArea;
  checkpoint.areaQuestions[selectedArea] ??= pickAreaQuestions(
    grayAreaMap.get(selectedArea) ?? defaultArea,
  );
  checkpoint.stage = "area-question";
  return "continue";
}

function buildFallbackAnswer(checkpoint: DiscussCheckpoint, area: string): string {
  if (area === "Canonical references") {
    return checkpoint.canonicalReferences[0] ?? ".planning/PROJECT.md";
  }
  if (area === "Risks and deferrals") {
    return "Defer adjacent scope until planning exposes actual need.";
  }
  return `Follow existing project pattern for ${area.toLowerCase()}.`;
}

async function resolveAreaQuestionStep(
  ctx: ExtensionCommandContext,
  checkpoint: DiscussCheckpoint,
  grayAreaMap: Map<string, GrayArea>,
  textReplyReader: { consume: () => string | undefined },
): Promise<"checkpoint" | "continue"> {
  while (checkpoint.stage === "area-question") {
    const area = checkpoint.activeArea;
    if (area === undefined) {
      checkpoint.stage = "gray-area-selection";
      return "continue";
    }
    const grayArea = grayAreaMap.get(area);
    if (grayArea === undefined) {
      checkpoint.stage = "gray-area-selection";
      return "continue";
    }
    const nextQuestion = checkpoint.areaQuestions[area]?.shift();
    if (nextQuestion === undefined) {
      checkpoint.stage = "area-more";
      return "continue";
    }
    const answer = await promptInput(
      ctx,
      checkpoint,
      `${area}: ${nextQuestion}`,
      grayArea.prompt,
      buildFallbackAnswer(checkpoint, area),
      textReplyReader,
    );
    if (answer === undefined) {
      checkpoint.areaQuestions[area].unshift(nextQuestion);
      return "checkpoint";
    }
    applyAreaAnswer(checkpoint, area, answer, checkpoint.auto ? "auto" : "user");
  }
  return "continue";
}

async function resolveAreaMoreStep(
  ctx: ExtensionCommandContext,
  checkpoint: DiscussCheckpoint,
  textReplyReader: { consume: () => string | undefined },
): Promise<"checkpoint" | "continue"> {
  if (checkpoint.stage !== "area-more") {
    return "continue";
  }
  const area = checkpoint.activeArea;
  if (area === undefined) {
    checkpoint.stage = "gray-area-selection";
    return "continue";
  }
  const nextAction = await promptSelect(
    ctx,
    checkpoint,
    `Continue area: ${area}`,
    ["Next area", "Ask one more", "Done with discussion"],
    textReplyReader,
  );
  if (nextAction === undefined) {
    return "checkpoint";
  }
  if (nextAction === "Ask one more") {
    checkpoint.areaQuestions[area] ??= [];
    checkpoint.areaQuestions[area].push(`Any final detail for ${area.toLowerCase()}?`);
    checkpoint.stage = "area-question";
    return "continue";
  }
  checkpoint.areasCompleted = appendUnique(checkpoint.areasCompleted, [area]);
  checkpoint.areasRemaining = checkpoint.areasRemaining.filter((item) => item !== area);
  delete checkpoint.activeArea;
  checkpoint.stage = nextAction === "Done with discussion" ? "final-loop" : "gray-area-selection";
  return "continue";
}

async function resolveFinalLoopStep(
  ctx: ExtensionCommandContext,
  checkpoint: DiscussCheckpoint,
  grayAreas: GrayArea[],
  textReplyReader: { consume: () => string | undefined },
): Promise<"checkpoint" | "done" | "continue"> {
  if (checkpoint.stage !== "final-loop") {
    return "continue";
  }
  const finalChoice = await promptSelect(
    ctx,
    checkpoint,
    "Discuss complete",
    ["Write context", "Explore more", "Capture deferred idea"],
    textReplyReader,
  );
  if (finalChoice === undefined) {
    return "checkpoint";
  }
  if (finalChoice === "Explore more") {
    checkpoint.areasRemaining = grayAreas
      .map((item) => item.area)
      .filter((item) => !checkpoint.areasCompleted.includes(item));
    checkpoint.stage = "gray-area-selection";
    return "continue";
  }
  if (finalChoice === "Capture deferred idea") {
    const deferred = await promptInput(
      ctx,
      checkpoint,
      "Deferred idea",
      "Describe out-of-scope idea",
      "Revisit adjacent optimization after base delivery lands.",
      textReplyReader,
    );
    if (deferred === undefined) {
      return "checkpoint";
    }
    checkpoint.deferredIdeas = appendUnique(checkpoint.deferredIdeas, [deferred]);
    checkpoint.draft.deferredIdeas = [...checkpoint.deferredIdeas];
    checkpoint.draft.discussionLog.push(`Deferred idea captured: ${deferred}`);
    const followUp = await promptSelect(
      ctx,
      checkpoint,
      "After deferred capture",
      ["Write context", "Explore more"],
      textReplyReader,
    );
    if (followUp === undefined) {
      return "checkpoint";
    }
    if (followUp === "Explore more") {
      checkpoint.stage = "gray-area-selection";
      return "continue";
    }
  }
  checkpoint.stage = "done";
  return "done";
}

async function runDefaultDiscussLoop(
  ctx: ExtensionCommandContext,
  checkpoint: DiscussCheckpoint,
  textReplyReader: { consume: () => string | undefined },
): Promise<"checkpoint" | "done"> {
  const grayAreas = grayAreasForCheckpoint(checkpoint);
  const grayAreaMap = new Map(grayAreas.map((item) => [item.area, item]));

  if (checkpoint.stage === "init") {
    checkpoint.stage = "existing-context";
  }

  const existingContextStep = await resolveExistingContextStep(ctx, checkpoint, textReplyReader);
  if (existingContextStep === "checkpoint") {
    return "checkpoint";
  }

  if (checkpoint.stage === "gray-area-analysis") {
    checkpoint.grayAreaAnalysis = buildGrayAreaAnalysis(checkpoint.route, grayAreas);
    checkpoint.draft.discussionLog.push(checkpoint.grayAreaAnalysis);
    checkpoint.stage = "gray-area-selection";
  }

  const selectionStep = await resolveGrayAreaSelectionStep(
    ctx,
    checkpoint,
    grayAreaMap,
    textReplyReader,
  );
  if (selectionStep === "checkpoint") {
    return "checkpoint";
  }

  const questionStep = await resolveAreaQuestionStep(ctx, checkpoint, grayAreaMap, textReplyReader);
  if (questionStep === "checkpoint") {
    return "checkpoint";
  }

  const areaMoreStep = await resolveAreaMoreStep(ctx, checkpoint, textReplyReader);
  if (areaMoreStep === "checkpoint") {
    return "checkpoint";
  }

  const finalStep = await resolveFinalLoopStep(ctx, checkpoint, grayAreas, textReplyReader);
  if (finalStep === "checkpoint") {
    return "checkpoint";
  }
  if (finalStep === "continue") {
    return "checkpoint";
  }

  return checkpoint.stage === "done" ? "done" : "checkpoint";
}

async function handleAssumptionsPreviewRoute(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  checkpoint: DiscussCheckpoint,
  phaseName: string,
): Promise<void> {
  const previewDraft = createEmptyDiscussDraft(checkpoint.draft.phaseBoundary);
  const previewCheckpoint = {
    ...checkpoint,
    canonicalReferences: [...checkpoint.canonicalReferences],
    deferredIdeas: [...checkpoint.deferredIdeas],
    draft: previewDraft,
  };
  const built = await buildAssumptionsDraft(pi, ctx, previewDraft, previewCheckpoint, phaseName);
  ctx.ui.notify(
    [
      `Assumptions preview for phase ${checkpoint.phase}:`,
      ...built.draft.implementationDecisions.map((item) => `- ${item.area}: ${item.decision}`),
      ...(built.researchGaps.length === 0
        ? []
        : ["Research gaps:", ...built.researchGaps.map((item) => `- ${item}`)]),
    ].join("\n"),
    "info",
  );
}

async function runAssumptionsRefineLoop(
  ctx: ExtensionCommandContext,
  checkpoint: DiscussCheckpoint,
  textReplyReader: { consume: () => string | undefined },
): Promise<"checkpoint" | "done"> {
  const assumptionAreas = checkpoint.draft.implementationDecisions.map((item) => item.area);
  if (assumptionAreas.length === 0) {
    checkpoint.pendingPrompt = "No assumptions available to refine.";
    checkpoint.promptOptions = [];
    return "checkpoint";
  }

  const selectedArea = await promptSelect(
    ctx,
    checkpoint,
    "Select assumption to refine",
    assumptionAreas,
    textReplyReader,
  );
  if (selectedArea === undefined) {
    return "checkpoint";
  }

  const existingDecision =
    checkpoint.draft.implementationDecisions.find((item) => item.area === selectedArea)?.decision ??
    "Describe corrected assumption";
  const correction = await promptInput(
    ctx,
    checkpoint,
    `Refine assumption: ${selectedArea}`,
    existingDecision,
    existingDecision,
    textReplyReader,
  );
  if (correction === undefined) {
    checkpoint.activeArea = selectedArea;
    return "checkpoint";
  }

  applyAreaAnswer(checkpoint, selectedArea, correction, checkpoint.auto ? "auto" : "user");
  checkpoint.draft.discussionLog.push(`Assumption refined for ${selectedArea}.`);
  checkpoint.stage = "done";
  return "done";
}

function finalizeDiscussSession(
  ctx: ExtensionCommandContext,
  current: ReturnType<typeof ensureCurrentPhaseDir>,
  checkpoint: DiscussCheckpoint,
): void {
  hydrateCheckpointSideChannels(checkpoint);
  checkpoint.draft.canonicalReferences = checkpoint.canonicalReferences.map((path) => {
    const existing = checkpoint.draft.canonicalReferences.find((item) => item.path === path);
    return existing ?? { path, reason: "Discuss canonical ref" };
  });
  checkpoint.draft.deferredIdeas = appendUnique(
    [...checkpoint.draft.deferredIdeas],
    checkpoint.deferredIdeas,
  );
  if (checkpoint.chain) {
    checkpoint.draft.chainNextStep = `/gsd plan-phase --phase ${current.phase.number}`;
  }
  writeDiscussArtifacts(
    current.phaseDir,
    current.phaseFilePrefix,
    normalizeDraftDecisionIds(checkpoint.draft),
  );
  removeDiscussCheckpoint(current.phaseDir);
  writeStateFields(ctx.cwd, {
    current_phase: current.phase.number,
    current_phase_name: current.phase.name,
    status: "Ready to plan",
  });
  ctx.ui.notify(
    `Discuss artifacts ready: ${join(current.phaseDir, `${current.phaseFilePrefix}-CONTEXT.md`)}`,
    "info",
  );
}

async function handleAssumptionsArtifactRoute(input: {
  pi: ExtensionAPI;
  ctx: ExtensionCommandContext;
  args: GsdCommandArgs;
  checkpoint: DiscussCheckpoint;
  current: ReturnType<typeof ensureCurrentPhaseDir>;
  existingCheckpoint: DiscussCheckpoint | undefined;
  textReplyReader: { consume: () => string | undefined };
}): Promise<"checkpoint" | "done"> {
  const shouldRefreshAssumptionsAnalysis =
    input.existingCheckpoint === undefined ||
    input.existingCheckpoint.route !== "assumptions-artifact";

  if (shouldRefreshAssumptionsAnalysis) {
    resetAssumptionsDerivedState(input.checkpoint);
    const assumptionsResult = await buildAssumptionsDraft(
      input.pi,
      input.ctx,
      input.checkpoint.draft,
      input.checkpoint,
      input.current.phase.name,
    );
    input.checkpoint.draft = assumptionsResult.draft;
    input.checkpoint.assumptionsAutoReady = assumptionsResult.allHighConfidence;
    input.checkpoint.assumptionsResearchGaps = assumptionsResult.researchGaps;
    hydrateCheckpointSideChannels(input.checkpoint);
    input.checkpoint.stage = "final-loop";
  }

  if (input.checkpoint.assumptionsResearchGaps.length > 0) {
    const gapResult = await resolveAssumptionsResearchGaps({
      pi: input.pi,
      ctx: input.ctx,
      checkpoint: input.checkpoint,
      current: input.current,
      textReplyReader: input.textReplyReader,
      rawInput: input.args.input,
      promptInput,
      writeCheckpoint: (nextCheckpoint) => {
        writeDiscussCheckpoint(input.current.phaseDir, nextCheckpoint);
      },
      notifyStop: (nextCheckpoint) => {
        notifyStop(input.ctx, nextCheckpoint);
      },
      hydrateCheckpointSideChannels,
      resetAssumptionsDerivedState,
    });
    if (gapResult === "checkpoint") {
      return "checkpoint";
    }
  }

  if (input.args.auto === true) {
    input.checkpoint.stage = "done";
    finalizeDiscussSession(input.ctx, input.current, input.checkpoint);
    return "done";
  }

  if (input.ctx.hasUI || input.checkpoint.text) {
    const choice = await promptSelect(
      input.ctx,
      input.checkpoint,
      "Assumptions review",
      ["Confirm assumptions", "Refine assumptions"],
      input.textReplyReader,
    );
    if (choice === undefined) {
      writeDiscussCheckpoint(input.current.phaseDir, input.checkpoint);
      notifyStop(input.ctx, input.checkpoint);
      return "checkpoint";
    }
    if (choice === "Refine assumptions") {
      const result = await runAssumptionsRefineLoop(
        input.ctx,
        input.checkpoint,
        input.textReplyReader,
      );
      if (result !== "done") {
        writeDiscussCheckpoint(input.current.phaseDir, input.checkpoint);
        notifyStop(input.ctx, input.checkpoint);
        return "checkpoint";
      }
    }
    input.checkpoint.stage = "done";
    finalizeDiscussSession(input.ctx, input.current, input.checkpoint);
    return "done";
  }

  input.checkpoint.pendingPrompt = `Assumptions ready for review for phase ${input.current.phase.number} ${input.current.phase.name}.`;
  input.checkpoint.promptOptions = ["Confirm assumptions", "Refine assumptions"];
  writeDiscussCheckpoint(input.current.phaseDir, input.checkpoint);
  notifyStop(input.ctx, input.checkpoint);
  return "checkpoint";
}

export async function handleGsdDiscussPhase(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: GsdCommandArgs,
): Promise<void> {
  const unsupportedModeError = args.unsupportedModeError;
  if (unsupportedModeError !== undefined && unsupportedModeError.length > 0) {
    ctx.ui.notify(unsupportedModeError, "warning");
    return;
  }

  const current = ensureCurrentPhaseDir(ctx.cwd, args.phase);
  const blockingResumeFile = readDiscussBlockingResumeFile(current.phaseDir);
  if (blockingResumeFile !== undefined && blockingResumeFile.length > 0) {
    ctx.ui.notify(
      `Blocking preflight: resolve ${blockingResumeFile} before /gsd discuss-phase. Acknowledge or resume pending work there first.`,
      "warning",
    );
    return;
  }

  const config = readDiscussConfig(ctx.cwd);
  const requestedRoute = resolveDiscussRoute(config, args);
  const existingCheckpoint =
    requestedRoute === "assumptions-preview" ? undefined : readDiscussCheckpoint(current.phaseDir);
  const route =
    requestedRoute === "assumptions-preview"
      ? requestedRoute
      : (existingCheckpoint?.route ?? requestedRoute);
  const mode = existingCheckpoint?.mode ?? resolveDiscussMode(config, args);
  const checkpoint = existingCheckpoint ?? buildCheckpoint(ctx.cwd, current, args, route, mode);
  const textReplyReader = createTextReplyReader(args.input);

  checkpoint.auto = args.auto === true || checkpoint.auto;
  checkpoint.chain = args.chain === true || checkpoint.chain;
  checkpoint.text = args.text === true || config?.workflow?.text_mode === true || checkpoint.text;
  checkpoint.all = args.all === true || checkpoint.all;
  hydrateCheckpointSideChannels(checkpoint);

  appendUnique(checkpoint.draft.existingCodeInsights, [checkpoint.scoutSummary]);
  syncCanonicalReferences(ctx.cwd, checkpoint);

  if (route === "assumptions-preview") {
    await handleAssumptionsPreviewRoute(pi, ctx, checkpoint, current.phase.name);
    return;
  }

  if (route === "assumptions-artifact") {
    await handleAssumptionsArtifactRoute({
      pi,
      ctx,
      args,
      checkpoint,
      current,
      existingCheckpoint,
      textReplyReader,
    });
    return;
  }

  let loopResult = await runDefaultDiscussLoop(ctx, checkpoint, textReplyReader);
  while (loopResult !== "done" && checkpoint.auto) {
    loopResult = await runDefaultDiscussLoop(ctx, checkpoint, textReplyReader);
  }
  if (loopResult === "done") {
    finalizeDiscussSession(ctx, current, checkpoint);
    return;
  }
  writeDiscussCheckpoint(current.phaseDir, checkpoint);
  notifyStop(ctx, checkpoint);
}
