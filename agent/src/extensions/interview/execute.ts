import { execSync } from "node:child_process";
import * as os from "node:os";
import { randomUUID } from "node:crypto";

import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

import { openBrowserTarget } from "../executor/browser.js";
import { getErrorMessage, toError } from "./errors.js";
import { buildAskModelsData, formatModelRef, selectGenerateModels } from "./generation.js";
import { createGenerationCallbacks } from "./generation-callbacks.js";
import {
  loadQuestions,
  expandHome,
  resolveOptionalPath,
  type SavedQuestionsFile,
} from "./questions.js";
import {
  buildAnsweredAgentResponseItems,
  filterAnsweredResponses,
  formatAnsweredResponsesForAgent,
  formatInterviewProgressMessage,
  getInterviewQuestionCount,
  hasAnyAnswers,
  hasQueuedMessages,
} from "./responses.js";
import { type InterviewDetails } from "./render.js";
import { defaultInterviewSettings, loadSettings, type InterviewThemeSettings } from "./settings.js";
import { getActiveSessions, startInterviewServer } from "./server.js";
import type { ResponseItem } from "./types.js";

export interface InterviewExecuteParams {
  questions: string;
  timeout?: number;
  verbose?: boolean;
  theme?: {
    mode?: string;
    name?: string;
    lightPath?: string;
    darkPath?: string;
    toggleHotkey?: string;
  };
}

const DEFAULT_THEME_HOTKEY = "mod+shift+l";

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 0) return "just now";
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
}

function toTerminalHyperlink(url: string, label?: string): string {
  return `\u001B]8;;${url}\u0007${label ?? url}\u001B]8;;\u0007`;
}

function shouldAutoOpenBrowser(): boolean {
  return (
    process.env.SSH_CONNECTION === undefined &&
    process.env.SSH_CLIENT === undefined &&
    process.env.SSH_TTY === undefined
  );
}

function mergeThemeConfig(
  base: InterviewThemeSettings | undefined,
  override: InterviewExecuteParams["theme"],
  cwd: string,
): InterviewThemeSettings {
  const normalizedOverride: InterviewThemeSettings | undefined =
    override === undefined
      ? undefined
      : {
          ...override,
          mode:
            override.mode === "auto" || override.mode === "light" || override.mode === "dark"
              ? override.mode
              : undefined,
        };
  const merged: InterviewThemeSettings = { ...base, ...normalizedOverride };
  return {
    ...merged,
    toggleHotkey: merged.toggleHotkey ?? DEFAULT_THEME_HOTKEY,
    lightPath: resolveOptionalPath(merged.lightPath, cwd),
    darkPath: resolveOptionalPath(merged.darkPath, cwd),
  };
}

function formatBranchSuffix(branch: string | null): string {
  return branch === null ? "" : ` (${branch})`;
}

function getCurrentApiModel(ctx: ExtensionContext): Model<Api> | null {
  if (ctx.model === undefined) {
    return null;
  }
  return ctx.modelRegistry.find(ctx.model.provider, ctx.model.id) ?? null;
}

function getConfiguredGenerateModel(
  ctx: ExtensionContext,
  generateModel: string | undefined,
): Model<Api> | null {
  if (generateModel === undefined) {
    return null;
  }
  const slashIndex = generateModel.indexOf("/");
  if (slashIndex <= 0) {
    return null;
  }
  return (
    ctx.modelRegistry.find(
      generateModel.slice(0, slashIndex),
      generateModel.slice(slashIndex + 1),
    ) ?? null
  );
}

function getCurrentGitBranch(cwd: string): string | null {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

function normalizeCwd(cwd: string): string {
  return cwd.startsWith(os.homedir()) ? `~${cwd.slice(os.homedir().length)}` : cwd;
}

function getFinishedText(options: {
  status: InterviewDetails["status"];
  responses: ResponseItem[];
  cancelReason?: "timeout" | "user" | "stale";
  timeoutSeconds: number;
  questionsData: SavedQuestionsFile;
}): string {
  const { status, responses, cancelReason, timeoutSeconds, questionsData } = options;
  if (status === "completed") {
    return `User completed interview form.\n\nAnswered responses:\n${formatAnsweredResponsesForAgent(responses, questionsData.questions)}`;
  }
  if (status === "cancelled") {
    if (cancelReason === "stale") {
      return "Interview session ended due to lost heartbeat.\n\nQuestions saved to: ~/.pi/interview-recovery/";
    }
    if (hasAnyAnswers(responses)) {
      const answered = filterAnsweredResponses(responses);
      return `User cancelled interview with partial responses.\n\nAnswered responses:\n${formatAnsweredResponsesForAgent(answered, questionsData.questions)}\n\nProceed with these inputs and use your best judgment for unanswered questions.`;
    }
    return "User skipped interview without providing answers. Proceed with your best judgment. Use recommended options where specified, make reasonable choices elsewhere. Do not ask for clarification unless absolutely necessary.";
  }
  if (status === "timeout") {
    if (hasAnyAnswers(responses)) {
      const answered = filterAnsweredResponses(responses);
      return `Interview form timed out after ${timeoutSeconds} seconds.\n\nAnswered responses before timeout:\n${formatAnsweredResponsesForAgent(answered, questionsData.questions)}\n\nQuestions saved to: ~/.pi/interview-recovery/\n\nProceed with these inputs and use your best judgment for unanswered questions.`;
    }
    return `Interview form timed out after ${timeoutSeconds} seconds.\n\nQuestions saved to: ~/.pi/interview-recovery/`;
  }
  return "Interview was aborted.";
}

function createQueuedDetails(options: {
  status: InterviewDetails["status"];
  url: string;
  responses: ResponseItem[];
  title: string;
  totalQuestions: number;
  questionsData: SavedQuestionsFile;
  queuedMessage?: string;
  progressMessage?: string;
}): InterviewDetails {
  const {
    status,
    url,
    responses,
    title,
    totalQuestions,
    questionsData,
    queuedMessage,
    progressMessage,
  } = options;
  return {
    status,
    url,
    responses,
    title,
    totalQuestions,
    answeredItems: buildAnsweredAgentResponseItems(responses, questionsData.questions),
    queuedMessage,
    progressMessage,
  };
}

function createQueuedMessage(options: {
  ctx: ExtensionContext;
  sessionId: string;
  url: string;
  interviewTitle: string;
  activeSession: {
    title: string;
    cwd: string;
    gitBranch: string | null;
    id: string;
    startedAt: number;
  };
}): string {
  const { ctx, sessionId, url, interviewTitle, activeSession } = options;
  const queuedLines = [
    "Interview already active:",
    `  Title: ${activeSession.title}`,
    `  Project: ${activeSession.cwd}${formatBranchSuffix(activeSession.gitBranch)}`,
    `  Session: ${activeSession.id.slice(0, 8)}`,
    `  Started: ${formatTimeAgo(activeSession.startedAt)}`,
    "",
    "New interview ready:",
    `  Title: ${interviewTitle}`,
    `  Project: ${normalizeCwd(ctx.cwd)}${(() => {
      const gitBranch = getCurrentGitBranch(ctx.cwd);
      return formatBranchSuffix(gitBranch);
    })()}`,
    `  Session: ${sessionId.slice(0, 8)}`,
    "",
    `Open when ready: ${toTerminalHyperlink(url, url)}`,
    "",
    "Server waiting until you open link.",
  ];
  return queuedLines.join("\n");
}

async function notifyInterviewReady(options: {
  ctx: ExtensionContext;
  onUpdate: AgentToolUpdateCallback<InterviewDetails> | undefined;
  handle: { url: string };
  sessionId: string;
  interviewTitle: string;
  totalQuestions: number;
  questionsData: SavedQuestionsFile;
  settings: typeof defaultInterviewSettings & {
    generateModel?: string;
    publicBaseUrl?: string;
    theme: InterviewThemeSettings;
  };
  verbose: boolean | undefined;
}): Promise<InterviewDetails> {
  const {
    ctx,
    onUpdate,
    handle,
    sessionId,
    interviewTitle,
    totalQuestions,
    questionsData,
    settings,
    verbose,
  } = options;
  const url = handle.url;
  const activeSessions = getActiveSessions();
  const otherActive = activeSessions.filter((session) => session.id !== sessionId);

  if (otherActive.length > 0) {
    const queuedMessage = createQueuedMessage({
      ctx,
      sessionId,
      url,
      interviewTitle,
      activeSession: otherActive[0],
    });
    if (onUpdate === undefined) {
      ctx.ui.notify("Interview queued; see tool panel for link.", "info");
    } else {
      onUpdate({
        content: [{ type: "text", text: "Interview queued; see tool panel for link." }],
        details: createQueuedDetails({
          status: "queued",
          url,
          responses: [],
          title: interviewTitle,
          totalQuestions,
          questionsData,
          queuedMessage,
        }),
      });
    }
    return createQueuedDetails({
      status: "queued",
      url,
      responses: [],
      title: interviewTitle,
      totalQuestions,
      questionsData,
      queuedMessage,
    });
  }

  const launchMessage = `Interview ready:\n  Title: ${interviewTitle}\n  Open: ${toTerminalHyperlink(url, url)}`;
  if (onUpdate === undefined) {
    ctx.ui.notify(`Interview ready: ${url}`, "info");
  } else {
    onUpdate({
      content: [{ type: "text", text: launchMessage }],
      details: createQueuedDetails({
        status: "queued",
        url,
        responses: [],
        title: interviewTitle,
        totalQuestions,
        questionsData,
        queuedMessage: launchMessage,
      }),
    });
  }

  if (settings.autoOpenBrowser && shouldAutoOpenBrowser()) {
    try {
      await openBrowserTarget(url);
    } catch (error) {
      if (verbose === true) {
        ctx.ui.notify(`Open browser manually: ${url}\n${getErrorMessage(error)}`, "warning");
      }
    }
  }

  return createQueuedDetails({
    status: "queued",
    url,
    responses: [],
    title: interviewTitle,
    totalQuestions,
    questionsData,
    queuedMessage: launchMessage,
  });
}

function createProgressDetails(options: {
  currentUrl: string;
  responses: ResponseItem[];
  interviewTitle: string;
  totalQuestions: number;
  questionsData: SavedQuestionsFile;
}): InterviewDetails {
  const { currentUrl, responses, interviewTitle, totalQuestions, questionsData } = options;
  const progress = formatInterviewProgressMessage(responses, questionsData.questions);
  return createQueuedDetails({
    status: "queued",
    url: currentUrl,
    responses,
    title: interviewTitle,
    totalQuestions,
    questionsData,
    queuedMessage: [
      "Interview in progress:",
      `  Open: ${toTerminalHyperlink(currentUrl, currentUrl)}`,
      `  Progress: ${progress}`,
    ].join("\n"),
    progressMessage: progress,
  });
}

function createServerCallbacks(options: {
  finish: (
    status: InterviewDetails["status"],
    responses?: ResponseItem[],
    cancelReason?: "timeout" | "user" | "stale",
  ) => void;
  onUpdate: AgentToolUpdateCallback<InterviewDetails> | undefined;
  isResolved: () => boolean;
  getCurrentUrl: () => string;
  interviewTitle: string;
  totalQuestions: number;
  questionsData: SavedQuestionsFile;
}) {
  const {
    finish,
    onUpdate,
    isResolved,
    getCurrentUrl,
    interviewTitle,
    totalQuestions,
    questionsData,
  } = options;
  return {
    onSubmit: (responses: ResponseItem[]) => {
      finish("completed", responses);
    },
    onCancel: (reason?: "timeout" | "user" | "stale", partialResponses?: ResponseItem[]) => {
      if (reason === "timeout") {
        finish("timeout", partialResponses ?? []);
        return;
      }
      finish("cancelled", partialResponses ?? [], reason);
    },
    onProgress: (responses: ResponseItem[]) => {
      if (onUpdate === undefined || isResolved()) {
        return;
      }
      onUpdate({
        content: [
          {
            type: "text",
            text: `Interview in progress. ${formatInterviewProgressMessage(responses, questionsData.questions)}`,
          },
        ],
        details: createProgressDetails({
          currentUrl: getCurrentUrl(),
          responses,
          interviewTitle,
          totalQuestions,
          questionsData,
        }),
      });
    },
  };
}

function launchInterviewServer(options: {
  ctx: ExtensionContext;
  params: InterviewExecuteParams;
  prepared: PreparedInterviewExecution;
  serverCallbacks: ReturnType<typeof createServerCallbacks>;
  onGenerate: ReturnType<typeof createGenerationCallbacks>["onGenerate"];
  onOptionInsight: ReturnType<typeof createGenerationCallbacks>["onOptionInsight"];
  setServerHandle: (handle: { close: () => void; url: string } | null) => void;
  setCurrentUrl: (url: string) => void;
  isResolved: () => boolean;
  cleanup: () => void;
  reject: (error: Error) => void;
  onUpdate: AgentToolUpdateCallback<InterviewDetails> | undefined;
}): void {
  const {
    ctx,
    params,
    prepared,
    serverCallbacks,
    onGenerate,
    onOptionInsight,
    setServerHandle,
    setCurrentUrl,
    isResolved,
    cleanup,
    reject,
    onUpdate,
  } = options;
  void startInterviewServer(
    {
      questions: prepared.questionsData,
      sessionToken: prepared.sessionToken,
      sessionId: prepared.sessionId,
      cwd: ctx.cwd,
      timeout: prepared.timeoutSeconds,
      port: prepared.settings.port,
      host: prepared.settings.host,
      publicBaseUrl: prepared.settings.publicBaseUrl,
      verbose: params.verbose,
      theme: prepared.themeConfig,
      snapshotDir: prepared.snapshotDir,
      autoSaveOnSubmit: prepared.settings.autoSaveOnSubmit,
      savedAnswers: prepared.questionsData.savedAnswers,
      savedOptionInsights: prepared.questionsData.savedOptionInsights,
      optionKeysByQuestion: prepared.questionsData.optionKeysByQuestion,
      canGenerate: prepared.generateModel !== null,
      askModels: prepared.askModels,
      defaultAskModel:
        prepared.generateModel === null ? null : formatModelRef(prepared.generateModel),
    },
    {
      ...serverCallbacks,
      onGenerate,
      onOptionInsight,
    },
  )
    .then(async (handle) => {
      if (isResolved()) {
        handle.close();
        return;
      }
      setServerHandle(handle);
      setCurrentUrl(handle.url);
      await notifyInterviewReady({
        ctx,
        onUpdate,
        handle,
        sessionId: prepared.sessionId,
        interviewTitle: prepared.interviewTitle,
        totalQuestions: prepared.totalQuestions,
        questionsData: prepared.questionsData,
        settings: prepared.settings,
        verbose: params.verbose,
      });
    })
    .catch((error: unknown) => {
      cleanup();
      reject(toError(error));
    });
}

interface PreparedInterviewExecution {
  settings: typeof defaultInterviewSettings & {
    generateModel?: string;
    publicBaseUrl?: string;
    theme: InterviewThemeSettings;
  };
  timeoutSeconds: number;
  themeConfig: InterviewThemeSettings;
  questionsData: SavedQuestionsFile;
  generateModel: Model<Api> | null;
  fallbackGenerateModel: Model<Api> | null;
  askModels: ReturnType<typeof buildAskModelsData>;
  snapshotDir: string | undefined;
  interviewTitle: string;
  totalQuestions: number;
  sessionId: string;
  sessionToken: string;
}

function prepareInterviewExecution(
  params: InterviewExecuteParams,
  ctx: ExtensionContext,
): PreparedInterviewExecution {
  const loadedSettings = loadSettings();
  const settings = {
    ...defaultInterviewSettings,
    ...loadedSettings,
    theme: { ...defaultInterviewSettings.theme, ...loadedSettings.theme },
  };
  const timeoutSeconds = params.timeout ?? settings.timeout;
  const themeConfig = mergeThemeConfig(settings.theme, params.theme, ctx.cwd);
  const questionsData = loadQuestions(params.questions, ctx.cwd);
  const configuredGenerateModel = getConfiguredGenerateModel(ctx, settings.generateModel);
  const availableGenerateModels = ctx.modelRegistry.getAvailable();
  const currentModel = getCurrentApiModel(ctx);
  const { primary: generateModel, fallback: fallbackGenerateModel } = selectGenerateModels(
    configuredGenerateModel,
    currentModel,
    availableGenerateModels,
  );
  const askModels = buildAskModelsData(
    availableGenerateModels,
    currentModel,
    generateModel,
    fallbackGenerateModel,
  );
  const snapshotDir = settings.snapshotDir ? expandHome(settings.snapshotDir) : undefined;
  const interviewTitle = questionsData.title ?? "Interview";
  const totalQuestions = getInterviewQuestionCount(questionsData.questions);
  const sessionId = randomUUID();
  const sessionToken = randomUUID();

  return {
    settings,
    timeoutSeconds,
    themeConfig,
    questionsData,
    generateModel,
    fallbackGenerateModel,
    askModels,
    snapshotDir,
    interviewTitle,
    totalQuestions,
    sessionId,
    sessionToken,
  };
}

function runInterviewSession(options: {
  prepared: PreparedInterviewExecution;
  params: InterviewExecuteParams;
  signal: AbortSignal | undefined;
  onUpdate: AgentToolUpdateCallback<InterviewDetails> | undefined;
  ctx: ExtensionContext;
}): Promise<AgentToolResult<InterviewDetails>> {
  const { prepared, params, signal, onUpdate, ctx } = options;
  const {
    timeoutSeconds,
    questionsData,
    generateModel,
    fallbackGenerateModel,
    interviewTitle,
    totalQuestions,
  } = prepared;

  const { onGenerate, onOptionInsight } = createGenerationCallbacks({
    ctx: { modelRegistry: ctx.modelRegistry },
    questionsData,
    generateModel,
    fallbackGenerateModel,
  });

  return new Promise<AgentToolResult<InterviewDetails>>((resolve, reject) => {
    let serverHandle: { close: () => void; url: string } | null = null;
    let resolved = false;
    let currentUrl = "";

    const cleanup = (): void => {
      if (serverHandle !== null) {
        serverHandle.close();
        serverHandle = null;
      }
    };

    const finish = (
      status: InterviewDetails["status"],
      responses: ResponseItem[] = [],
      cancelReason?: "timeout" | "user" | "stale",
    ): void => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve({
        content: [
          {
            type: "text",
            text: getFinishedText({
              status,
              responses,
              cancelReason,
              timeoutSeconds,
              questionsData,
            }),
          },
        ],
        details: createQueuedDetails({
          status,
          url: currentUrl,
          responses,
          title: interviewTitle,
          totalQuestions,
          questionsData,
        }),
      });
    };

    signal?.addEventListener(
      "abort",
      () => {
        finish("aborted");
      },
      { once: true },
    );

    const serverCallbacks = createServerCallbacks({
      finish,
      onUpdate,
      isResolved: () => resolved,
      getCurrentUrl: () => currentUrl,
      interviewTitle,
      totalQuestions,
      questionsData,
    });

    launchInterviewServer({
      ctx,
      params,
      prepared,
      serverCallbacks,
      onGenerate,
      onOptionInsight,
      setServerHandle: (handle) => {
        serverHandle = handle;
      },
      setCurrentUrl: (url) => {
        currentUrl = url;
      },
      isResolved: () => resolved,
      cleanup,
      reject,
      onUpdate,
    });
  });
}

export function executeInterviewTool(
  params: InterviewExecuteParams,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<InterviewDetails> | undefined,
  ctx: ExtensionContext,
): Promise<AgentToolResult<InterviewDetails>> {
  if (!ctx.hasUI) {
    throw new Error(
      "Interview tool requires interactive mode. Cannot run in headless/RPC/print mode.",
    );
  }
  if (hasQueuedMessages(ctx)) {
    return Promise.resolve({
      content: [{ type: "text", text: "Interview skipped - user has queued input." }],
      details: { status: "cancelled", url: "", responses: [] },
    });
  }
  if (signal?.aborted === true) {
    return Promise.resolve({
      content: [{ type: "text", text: "Interview was aborted." }],
      details: { status: "aborted", url: "", responses: [] },
    });
  }

  return runInterviewSession({
    prepared: prepareInterviewExecution(params, ctx),
    params,
    signal,
    onUpdate,
    ctx,
  });
}
