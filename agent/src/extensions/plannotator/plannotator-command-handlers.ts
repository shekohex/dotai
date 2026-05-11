import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { createTextComponent, formatToolRail } from "../coreui/tools.js";

import {
  FILE_BROWSER_EXCLUDED,
  hasMarkdownFiles,
  resolveUserPath,
  htmlToMarkdown,
  isConvertedSource,
  urlToMarkdown,
  loadConfig,
  resolveUseJina,
  buildPlanFileRule,
  getAnnotateFileFeedbackPrompt,
  getAnnotateMessageFeedbackPrompt,
  getPlanApprovedPrompt,
  getPlanApprovedWithNotesPrompt,
  getPlanAutoApprovedPrompt,
  getPlanDeniedPrompt,
  getPlanToolName,
  getReviewApprovedPrompt,
  getReviewDeniedSuffix,
  resolveAtReference,
  parseAnnotateArgs,
  parseReviewArgs,
  getStartupErrorMessage,
  hasPlanBrowserHtml,
  hasReviewBrowserHtml,
  openArchiveBrowserAction,
  startPlanReviewBrowserSession,
  startCodeReviewBrowserSession,
  startLastMessageAnnotationSession,
  startMarkdownAnnotationSession,
  getLastAssistantMessageSnapshot,
} from "./plannotator-command-deps.js";
import { getPiSessionIdentity, type PiSessionIdentity } from "./current-pi-session.js";
import { PLAN_SUBMIT_TOOL, isPlanWritePathAllowed, type Phase } from "./tool-scope.js";
import {
  anchorMessageFeedback,
  reportBackgroundError,
  safeNotify,
  sendUserMessageWithCurrentSessionFallback,
  shouldAnchorLastMessageFeedback,
} from "./plannotator-support.js";
import { errorMessage } from "../../utils/error-message.js";
import { isSshSession, resolveBrowserAccessUrl } from "../../utils/browser-launch.js";
import { getServerPort } from "./server/network.js";

const PlanSubmitParametersSchema = Type.Object({
  filePath: Type.String({
    description:
      "Path to markdown plan file, relative to working directory. Must end in .md or .mdx and resolve inside cwd.",
  }),
});

const RunningReviewServerSchema = Type.Object({
  agentCwd: Type.Optional(Type.String()),
  gitContext: Type.Optional(
    Type.Object({
      cwd: Type.Optional(Type.String()),
    }),
  ),
});

type SessionUpdater = { update: (ctx: ExtensionContext) => void };

type PlanSubmitResultDetails = {
  status: "queued" | "approved" | "denied" | "auto-approved" | "error";
  approved: boolean;
  feedback?: string;
  url?: string;
  filePath?: string;
};

type PlanRenderContext = {
  isError: boolean;
  isPartial: boolean;
  lastComponent: unknown;
};

function toTerminalHyperlink(url: string, label?: string): string {
  return `\u001B]8;;${url}\u0007${label ?? url}\u001B]8;;\u0007`;
}

function isPlanSubmitResultDetails(value: unknown): value is PlanSubmitResultDetails {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    typeof value.status === "string" &&
    "approved" in value &&
    typeof value.approved === "boolean"
  );
}

export function renderPlanSubmitResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: PlanRenderContext,
) {
  const rail = formatToolRail(theme, context);
  if (!isPlanSubmitResultDetails(result.details)) {
    return createTextComponent(
      context.lastComponent,
      `${rail}${theme.bold(theme.fg(context.isError ? "error" : "dim", "plan review"))}`,
    );
  }
  const details = result.details;
  let statusColor: "success" | "warning" | "error";
  if (details.status === "approved" || details.status === "auto-approved") {
    statusColor = "success";
  } else if (details.status === "error") {
    statusColor = "error";
  } else {
    statusColor = "warning";
  }
  const header = `${rail}${theme.bold(theme.fg(statusColor, details.status))} ${theme.fg("muted", details.filePath ?? "plan")}${details.url === undefined ? "" : ` ${theme.fg("dim", "·")} ${theme.fg("dim", toTerminalHyperlink(details.url, theme.underline("open")))}`}`;
  if (!options.expanded) {
    return createTextComponent(context.lastComponent, header);
  }
  const lines = [header];
  if (details.feedback !== undefined && details.feedback.length > 0) {
    lines.push(`${rail}${theme.fg("dim", details.feedback)}`);
  }
  return createTextComponent(context.lastComponent, lines.join("\n"));
}

function notifyBrowserSessionStarted(ctx: ExtensionContext, label: string, url: string): void {
  const openUrl = toTerminalHyperlink(url, url);
  const modeLine = isSshSession()
    ? "Open this URL in your local browser:"
    : "Browser session ready:";
  ctx.ui.notify(`${label}\n${modeLine}\n${openUrl}`, "info");
}

function isPortInUseStartupError(err: unknown): boolean {
  return getStartupErrorMessage(err).includes("in use after");
}

function normalizeWorkspacePath(filePath: string): string {
  return resolve(filePath);
}

async function canReconnectToRunningReviewServerForCwd(cwd: string): Promise<string | null> {
  const { port } = getServerPort();
  if (port <= 0) {
    return null;
  }

  const localhostUrl = `http://127.0.0.1:${port}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, 1000);

  try {
    const response = await fetch(`${localhostUrl}/api/diff`, {
      method: "GET",
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const payload: unknown = await response.json();
    if (!Value.Check(RunningReviewServerSchema, payload)) {
      return null;
    }
    const expectedCwd = normalizeWorkspacePath(cwd);
    let serverCwd: string | null = null;
    if (typeof payload.agentCwd === "string") {
      serverCwd = payload.agentCwd;
    } else if (typeof payload.gitContext?.cwd === "string") {
      serverCwd = payload.gitContext.cwd;
    }
    if (serverCwd === null || normalizeWorkspacePath(serverCwd) !== expectedCwd) {
      return null;
    }
    return resolveBrowserAccessUrl({ serverUrl: localhostUrl, port });
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function handleReviewDecision(args: {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  origin: PiSessionIdentity;
  isPRReview: boolean;
  result: Awaited<
    ReturnType<Awaited<ReturnType<typeof startCodeReviewBrowserSession>>["waitForDecision"]>
  >;
}): void {
  const { pi, ctx, origin, isPRReview, result } = args;
  if (result.exit === true) {
    safeNotify(ctx, "Code review session closed.", "info", origin);
    return;
  }
  if (result.approved) {
    sendUserMessageWithCurrentSessionFallback(
      pi,
      getReviewApprovedPrompt("pi", loadConfig()),
      { deliverAs: "followUp" },
      "Plannotator code review feedback could not be sent",
      origin,
    );
    return;
  }
  if (result.feedback === undefined || result.feedback.length === 0) {
    safeNotify(ctx, "Code review closed (no feedback).", "info", origin);
    return;
  }
  sendUserMessageWithCurrentSessionFallback(
    pi,
    isPRReview ? result.feedback : `${result.feedback}${getReviewDeniedSuffix("pi", loadConfig())}`,
    { deliverAs: "followUp" },
    "Plannotator code review feedback could not be sent",
    origin,
  );
}

export function createPlannotatorReviewHandler(args: {
  pi: ExtensionAPI;
  currentPiSession: SessionUpdater;
}) {
  return async (rawArgs: string | undefined, ctx: ExtensionContext): Promise<void> => {
    if (!hasReviewBrowserHtml()) {
      ctx.ui.notify("Code review UI not available. Run 'npm run build' in repo root.", "error");
      return;
    }

    args.currentPiSession.update(ctx);
    const origin = getPiSessionIdentity(ctx);

    try {
      const reviewArgs = parseReviewArgs(rawArgs ?? "");
      const isPRReview = reviewArgs.prUrl !== undefined;
      const session = await startCodeReviewBrowserSession(ctx, {
        prUrl: reviewArgs.prUrl,
        vcsType: reviewArgs.vcsType,
        useLocal: reviewArgs.useLocal,
      });
      notifyBrowserSessionStarted(
        ctx,
        "Code review ready. You can keep chatting while it runs.",
        session.url,
      );
      void session
        .waitForDecision()
        .then((result) => {
          try {
            handleReviewDecision({ pi: args.pi, ctx, origin, isPRReview, result });
          } catch (err) {
            reportBackgroundError(
              ctx,
              "Plannotator code review feedback could not be sent",
              err,
              origin,
            );
          }
        })
        .catch((err) => {
          reportBackgroundError(ctx, "Plannotator code review session failed", err, origin);
        });
    } catch (err) {
      if (isPortInUseStartupError(err)) {
        const existingUrl = await canReconnectToRunningReviewServerForCwd(ctx.cwd);
        if (existingUrl !== null) {
          notifyBrowserSessionStarted(
            ctx,
            "Code review already running. Reusing existing browser session.",
            existingUrl,
          );
          return;
        }
      }
      ctx.ui.notify(`Failed to start code review UI: ${getStartupErrorMessage(err)}`, "error");
    }
  };
}

type AnnotationTarget = {
  markdown: string;
  absolutePath: string;
  folderPath?: string;
  mode: "annotate" | "annotate-folder";
  sourceInfo?: string;
  sourceConverted: boolean;
  isFolder: boolean;
};

async function resolveAnnotationTarget(
  filePath: string,
  rawFilePath: string,
  ctx: ExtensionContext,
): Promise<AnnotationTarget | null> {
  if (/^https?:\/\//i.test(filePath)) {
    const useJina = resolveUseJina(false, loadConfig());
    ctx.ui.notify(
      `Fetching: ${filePath}${useJina ? " (via Jina Reader)" : " (via fetch+Turndown)"}...`,
      "info",
    );
    const result = await urlToMarkdown(filePath, { useJina });
    return {
      markdown: result.markdown,
      absolutePath: filePath,
      mode: "annotate",
      sourceInfo: filePath,
      sourceConverted: isConvertedSource(result.source),
      isFolder: false,
    };
  }

  const resolvedCandidate = resolveAtReference(rawFilePath, (candidate) => {
    const absolutePath = resolveUserPath(candidate, ctx.cwd);
    return existsSync(absolutePath);
  });
  if (resolvedCandidate === null) {
    ctx.ui.notify(`File not found: ${resolveUserPath(filePath, ctx.cwd)}`, "error");
    return null;
  }

  const absolutePath = resolveUserPath(resolvedCandidate, ctx.cwd);
  let isFolder = false;
  try {
    isFolder = statSync(absolutePath).isDirectory();
  } catch {
    ctx.ui.notify(`Cannot access: ${absolutePath}`, "error");
    return null;
  }

  if (isFolder) {
    if (!hasMarkdownFiles(absolutePath, FILE_BROWSER_EXCLUDED, /\.(mdx?|html?)$/i)) {
      ctx.ui.notify(`No markdown or HTML files found in ${absolutePath}`, "error");
      return null;
    }
    ctx.ui.notify(`Opening annotation UI for folder ${filePath}...`, "info");
    return {
      markdown: "",
      absolutePath,
      folderPath: absolutePath,
      mode: "annotate-folder",
      sourceConverted: false,
      isFolder: true,
    };
  }

  if (/\.html?$/i.test(absolutePath)) {
    const fileSize = statSync(absolutePath).size;
    if (fileSize > 10 * 1024 * 1024) {
      ctx.ui.notify(`File too large (${Math.round(fileSize / 1024 / 1024)}MB, max 10MB)`, "error");
      return null;
    }
    ctx.ui.notify(`Opening annotation UI for ${filePath}...`, "info");
    return {
      markdown: htmlToMarkdown(readFileSync(absolutePath, "utf-8")),
      absolutePath,
      mode: "annotate",
      sourceInfo: basename(absolutePath),
      sourceConverted: true,
      isFolder: false,
    };
  }

  ctx.ui.notify(`Opening annotation UI for ${filePath}...`, "info");
  return {
    markdown: readFileSync(absolutePath, "utf-8"),
    absolutePath,
    mode: "annotate",
    sourceConverted: false,
    isFolder: false,
  };
}

export function createPlannotatorAnnotateHandler(args: {
  pi: ExtensionAPI;
  currentPiSession: SessionUpdater;
}) {
  return async (rawArgs: string | undefined, ctx: ExtensionContext): Promise<void> => {
    const { filePath, rawFilePath, gate } = parseAnnotateArgs(rawArgs ?? "");
    if (filePath === undefined || filePath.length === 0) {
      ctx.ui.notify(
        "Usage: /plannotator-annotate <file.md | file.html | https://... | folder/> [--gate] [--json]",
        "error",
      );
      return;
    }
    if (!hasPlanBrowserHtml()) {
      ctx.ui.notify(
        "Annotation UI not available. Run 'bun run build' in the pi-extension directory.",
        "error",
      );
      return;
    }

    let target: AnnotationTarget | null;
    try {
      target = await resolveAnnotationTarget(filePath, rawFilePath, ctx);
    } catch (err) {
      ctx.ui.notify(`Failed to fetch URL: ${errorMessage(err)}`, "error");
      return;
    }
    if (target === null) return;

    args.currentPiSession.update(ctx);
    const origin = getPiSessionIdentity(ctx);
    try {
      const session = await startMarkdownAnnotationSession(
        ctx,
        target.absolutePath,
        target.markdown,
        target.mode,
        target.folderPath,
        target.sourceInfo,
        target.sourceConverted,
        gate,
      );
      notifyBrowserSessionStarted(
        ctx,
        "Annotation ready. You can keep chatting while it runs.",
        session.url,
      );
      void session
        .waitForDecision()
        .then((result) => {
          try {
            if (result.exit === true) {
              safeNotify(ctx, "Annotation session closed.", "info", origin);
              return;
            }
            if (result.approved === true) {
              safeNotify(ctx, "Annotation approved.", "info", origin);
              return;
            }
            if (result.feedback === undefined || result.feedback.length === 0) {
              safeNotify(ctx, "Annotation closed (no feedback).", "info", origin);
              return;
            }
            sendUserMessageWithCurrentSessionFallback(
              args.pi,
              getAnnotateFileFeedbackPrompt("pi", loadConfig(), {
                fileHeader: target.isFolder ? "Folder" : "File",
                filePath: target.absolutePath,
                feedback: result.feedback,
              }),
              { deliverAs: "followUp" },
              "Plannotator annotation feedback could not be sent",
              origin,
            );
          } catch (err) {
            reportBackgroundError(
              ctx,
              "Plannotator annotation feedback could not be sent",
              err,
              origin,
            );
          }
        })
        .catch((err) => {
          reportBackgroundError(ctx, "Plannotator annotation session failed", err, origin);
        });
    } catch (err) {
      ctx.ui.notify(`Failed to start annotation UI: ${getStartupErrorMessage(err)}`, "error");
    }
  };
}

export function createPlannotatorLastHandler(args: {
  pi: ExtensionAPI;
  currentPiSession: SessionUpdater;
}) {
  return async (rawArgs: string | undefined, ctx: ExtensionContext): Promise<void> => {
    const { gate } = parseAnnotateArgs(rawArgs ?? "");
    if (!hasPlanBrowserHtml()) {
      ctx.ui.notify(
        "Annotation UI not available. Run 'bun run build' in the pi-extension directory.",
        "error",
      );
      return;
    }
    args.currentPiSession.update(ctx);
    const origin = getPiSessionIdentity(ctx);
    const snapshot = getLastAssistantMessageSnapshot(ctx);
    if (snapshot === null) {
      ctx.ui.notify("No assistant message found in session.", "error");
      return;
    }
    ctx.ui.notify("Opening annotation UI for last message...", "info");
    try {
      const session = await startLastMessageAnnotationSession(ctx, snapshot.text, gate);
      notifyBrowserSessionStarted(
        ctx,
        "Last-message annotation ready. You can keep chatting while it runs.",
        session.url,
      );
      void session
        .waitForDecision()
        .then((result) => {
          try {
            if (result.exit === true) {
              safeNotify(ctx, "Annotation session closed.", "info", origin);
              return;
            }
            if (result.approved === true) {
              safeNotify(ctx, "Message approved.", "info", origin);
              return;
            }
            if (result.feedback === undefined || result.feedback.length === 0) {
              safeNotify(ctx, "Annotation closed (no feedback).", "info", origin);
              return;
            }
            const feedback = shouldAnchorLastMessageFeedback(ctx, snapshot.entryId, origin)
              ? anchorMessageFeedback(result.feedback, snapshot.text)
              : result.feedback;
            sendUserMessageWithCurrentSessionFallback(
              args.pi,
              getAnnotateMessageFeedbackPrompt("pi", loadConfig(), { feedback }),
              { deliverAs: "followUp" },
              "Plannotator message annotation feedback could not be sent",
              origin,
            );
          } catch (err) {
            reportBackgroundError(
              ctx,
              "Plannotator message annotation feedback could not be sent",
              err,
              origin,
            );
          }
        })
        .catch((err) => {
          reportBackgroundError(ctx, "Plannotator message annotation session failed", err, origin);
        });
    } catch (err) {
      ctx.ui.notify(`Failed to start annotation UI: ${getStartupErrorMessage(err)}`, "error");
    }
  };
}

export function createPlannotatorArchiveHandler() {
  return async (_rawArgs: string | undefined, ctx: ExtensionContext): Promise<void> => {
    if (!hasPlanBrowserHtml()) {
      ctx.ui.notify(
        "Archive UI not available. Run 'bun run build' in the pi-extension directory.",
        "error",
      );
      return;
    }
    ctx.ui.notify("Opening plan archive...", "info");
    try {
      await openArchiveBrowserAction(ctx);
      ctx.ui.notify("Archive browser closed.", "info");
    } catch (err) {
      ctx.ui.notify(`Failed to start archive: ${getStartupErrorMessage(err)}`, "error");
    }
  };
}

export function registerPlanSubmitTool(args: {
  pi: ExtensionAPI;
  getPhase: () => Phase;
  setPhase: (phase: Phase) => void;
  getLastSubmittedPath: () => string | null;
  setLastSubmittedPath: (path: string | null) => void;
  persistState: () => void;
  applyPhaseConfig: (
    ctx: ExtensionContext,
    opts?: { restoreSavedState?: boolean },
  ) => Promise<void>;
  setJustApprovedPlan: (value: boolean) => void;
}): void {
  args.pi.registerTool({
    name: PLAN_SUBMIT_TOOL,
    label: "Submit Plan",
    renderShell: "self",
    description:
      "Submit your Plannotator plan for user review. Call this only while Plannotator planning mode is active, after writing your plan as a markdown file anywhere inside the working directory. Pass the path to the plan file (e.g. PLAN.md or plans/auth.md). The user will review the plan in a visual browser UI and can approve, deny with feedback, or annotate it. If denied, edit the same file in place, then call this again with the same path.",
    parameters: PlanSubmitParametersSchema,
    execute(_toolCallId, params, _signal, onUpdate, ctx) {
      return executePlanSubmitTool(args, params.filePath, ctx, onUpdate);
    },
    renderCall(_args, _theme, context) {
      return createTextComponent(context.lastComponent, "");
    },
    renderResult: renderPlanSubmitResult,
  });
}

type PlanToolResult = AgentToolResult<PlanSubmitResultDetails>;
type PlanReadResult = { planContent: string } | { error: PlanToolResult };

function createPlanToolResult(text: string, approved: boolean, feedback?: string): PlanToolResult {
  return {
    content: [{ type: "text" as const, text }],
    details: {
      status: approved ? "approved" : "denied",
      approved,
      ...(feedback === undefined ? {} : { feedback }),
    },
  };
}

function validatePlanInput(inputPath: string, cwd: string) {
  if (inputPath.length === 0) {
    return createPlanToolResult(
      `Error: ${PLAN_SUBMIT_TOOL} requires a filePath argument pointing to your markdown plan file (e.g. "PLAN.md" or "plans/auth.md").`,
      false,
    );
  }
  if (!isPlanWritePathAllowed(inputPath, cwd)) {
    return createPlanToolResult(
      `Error: plan file must be a markdown file (.md or .mdx) inside the working directory. Rejected: ${inputPath}`,
      false,
    );
  }
  return null;
}

function readPlanContent(inputPath: string, cwd: string): PlanReadResult {
  const fullPath = resolve(cwd, inputPath);
  try {
    if (!statSync(fullPath).isFile()) {
      return {
        error: createPlanToolResult(
          `Error: ${inputPath} is not a regular file. Write your plan to a markdown file first, then call ${PLAN_SUBMIT_TOOL} with its path.`,
          false,
        ),
      };
    }
  } catch {
    return {
      error: createPlanToolResult(
        `Error: ${inputPath} does not exist. Write your plan using the write tool first, then call ${PLAN_SUBMIT_TOOL} again.`,
        false,
      ),
    };
  }
  try {
    const planContent = readFileSync(fullPath, "utf-8");
    if (planContent.trim().length === 0) {
      return {
        error: createPlanToolResult(
          `Error: ${inputPath} is empty. Write your plan first, then call ${PLAN_SUBMIT_TOOL} again.`,
          false,
        ),
      };
    }
    return { planContent };
  } catch (err) {
    return {
      error: createPlanToolResult(
        `Error: failed to read ${inputPath}: ${errorMessage(err)}`,
        false,
      ),
    };
  }
}

async function transitionToExecution(
  args: Parameters<typeof registerPlanSubmitTool>[0],
  ctx: ExtensionContext,
): Promise<void> {
  args.setPhase("executing");
  await args.applyPhaseConfig(ctx, { restoreSavedState: true });
  args.pi.appendEntry("plannotator-execute", {
    lastSubmittedPath: args.getLastSubmittedPath(),
  });
  args.persistState();
  args.setJustApprovedPlan(true);
}

async function executePlanSubmitTool(
  args: Parameters<typeof registerPlanSubmitTool>[0],
  rawFilePath: string,
  ctx: ExtensionContext,
  onUpdate?: (result: AgentToolResult<PlanSubmitResultDetails>) => void,
): Promise<PlanToolResult> {
  if (args.getPhase() !== "planning") {
    return createPlanToolResult(
      "Error: Not in plan mode. Use /plannotator to enter planning mode first.",
      false,
    );
  }
  const inputPath = rawFilePath.trim();
  const validationError = validatePlanInput(inputPath, ctx.cwd);
  if (validationError !== null) return validationError;
  const readResult = readPlanContent(inputPath, ctx.cwd);
  if ("error" in readResult) return readResult.error;

  args.setLastSubmittedPath(inputPath);
  if (!ctx.hasUI || !hasPlanBrowserHtml()) {
    await transitionToExecution(args, ctx);
    return {
      content: [{ type: "text", text: getPlanAutoApprovedPrompt("pi", loadConfig()) }],
      details: { status: "auto-approved", approved: true, filePath: inputPath },
      terminate: true,
    };
  }

  let session: Awaited<ReturnType<typeof startPlanReviewBrowserSession>>;
  try {
    session = await startPlanReviewBrowserSession(ctx, readResult.planContent);
    onUpdate?.({
      content: [{ type: "text", text: `Plan review ready: ${session.url}` }],
      details: { status: "queued", approved: false, url: session.url, filePath: inputPath },
    });
  } catch (err) {
    const message = `Failed to start plan review UI: ${getStartupErrorMessage(err)}`;
    ctx.ui.notify(message, "error");
    return {
      content: [{ type: "text", text: message }],
      details: { status: "error", approved: false, feedback: message, filePath: inputPath },
    };
  }
  const result = await session.waitForDecision();

  if (result.approved) {
    await transitionToExecution(args, ctx);
    if (result.feedback !== undefined && result.feedback.length > 0) {
      return {
        content: [
          {
            type: "text",
            text: getPlanApprovedWithNotesPrompt("pi", loadConfig(), {
              planFilePath: inputPath,
              doneMsg: "",
              feedback: result.feedback,
            }),
          },
        ],
        details: {
          status: "approved",
          approved: true,
          feedback: result.feedback,
          filePath: inputPath,
        },
        terminate: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: getPlanApprovedPrompt("pi", loadConfig(), { planFilePath: inputPath, doneMsg: "" }),
        },
      ],
      details: { status: "approved", approved: true, filePath: inputPath },
      terminate: true,
    };
  }

  args.persistState();
  const feedbackText = result.feedback ?? "Plan rejected. Please revise.";
  return {
    content: [
      {
        type: "text",
        text: getPlanDeniedPrompt("pi", loadConfig(), {
          toolName: getPlanToolName("pi"),
          planFileRule: buildPlanFileRule(getPlanToolName("pi"), inputPath),
          feedback: feedbackText,
        }),
      },
    ],
    details: { status: "denied", approved: false, feedback: feedbackText, filePath: inputPath },
  };
}
