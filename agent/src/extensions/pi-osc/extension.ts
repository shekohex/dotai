import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import {
  ASK_USER_QUESTION_ANSWERED_EVENT,
  ASK_USER_QUESTION_CANCELLED_EVENT,
  ASK_USER_QUESTION_PROMPT_EVENT,
  isAskUserQuestionEventPayload,
  type AskUserQuestionEventPayload,
} from "../ask-user-question/events.js";
import { GOAL_PROGRESS_EVENT, GoalProgressEventSchema } from "../goal/types.js";
import {
  extractLastAssistantText,
  formatNotification,
  shouldNotifyAgentEnd,
} from "../terminal-notify.js";
import {
  createTmuxPassthroughSequence,
  getTmuxClientTty,
  getTmuxPaneTty,
  terminalNotifyRuntime,
} from "../terminal-notify.js";
import { createPiOscSequence, type PiOscEnvelope, type PiOscV1Event } from "./encoder.js";
import type { PiOscV1Payload } from "./schemas.js";
import {
  interviewDetailsFromResult,
  toolLabel,
  toolSummary,
  toolTitleActivity,
} from "./tool-presentations.js";
import { createTitleSpinnerController, type TitleActivity } from "./title-spinner.js";
import { readChildState } from "../../subagent-sdk/index.js";

export const piOscRuntime = {
  now: () => Date.now(),
  randomId: () => randomUUID(),
};

const THINKING_LABEL = "Thinking";
const THINKING_DEBOUNCE_MS = 750;

const boundedText = (value: string, maxLength: number): string =>
  value.length <= maxLength ? value : value.slice(0, maxLength);

const boundedOptionalText = (value: string | undefined, maxLength: number): string | undefined =>
  value === undefined ? undefined : boundedText(value, maxLength);

const questionEventTitle = (questionCount: number): string =>
  questionCount === 1 ? "Question for you" : `${questionCount} questions for you`;

const questionEventBody = (event: AskUserQuestionEventPayload): string => {
  const firstQuestion = event.questions[0]?.question;
  if (event.type === "answered") return "User answered question prompt.";
  if (event.type === "cancelled") return "User cancelled question prompt.";
  return firstQuestion ?? "Agent needs input.";
};

const questionEventRequiresScreenshot = (event: AskUserQuestionEventPayload): boolean =>
  event.questions.some((question) => question.screenshotPrompt !== undefined);

const questionOscState = (
  event: AskUserQuestionEventPayload,
): "prompted" | "answered" | "cancelled" => {
  switch (event.type) {
    case "prompt":
      return "prompted";
    case "answered":
      return "answered";
    case "cancelled":
      return "cancelled";
    default: {
      const _unreachable: never = event;
      return _unreachable;
    }
  }
};

const writePiOscSequence = (sequence: string): void => {
  const paneTty = getTmuxPaneTty();
  if (paneTty === null) {
    terminalNotifyRuntime.stdoutWrite(sequence);
    return;
  }

  const clientTty = getTmuxClientTty();
  if (clientTty !== null) {
    try {
      terminalNotifyRuntime.writeFileSync(clientTty, sequence, { encoding: "utf8" });
      return;
    } catch {}

    try {
      terminalNotifyRuntime.writeFileSync(clientTty, createTmuxPassthroughSequence(sequence), {
        encoding: "utf8",
      });
      return;
    } catch {}
  }

  try {
    terminalNotifyRuntime.writeFileSync(paneTty, createTmuxPassthroughSequence(sequence), {
      encoding: "utf8",
    });
    return;
  } catch {}

  terminalNotifyRuntime.stdoutWrite(sequence);
};

export const createPiOscEnvelope = (
  ctx: ExtensionContext,
  seq: number,
  data: PiOscV1Payload,
): PiOscEnvelope => ({
  id: piOscRuntime.randomId(),
  ts: piOscRuntime.now(),
  source: "agent",
  sessionId: ctx.sessionManager.getSessionId(),
  cwd: ctx.cwd,
  seq,
  data,
});

export const emitPiOscEvent = (
  eventName: PiOscV1Event,
  ctx: ExtensionContext,
  seq: number,
  data: PiOscV1Payload,
): void => {
  writePiOscSequence(createPiOscSequence(eventName, createPiOscEnvelope(ctx, seq, data)));
};

const handleAgentEnd = (
  event: { messages?: Array<{ role?: string; content?: unknown; stopReason?: string }> },
  ctx: ExtensionContext,
  childState: ReturnType<typeof readChildState>,
  emit: (eventName: PiOscV1Event, ctx: ExtensionContext, data: PiOscV1Payload) => void,
  abortAlertAlreadyEmitted = false,
): void => {
  emit("agent.run", ctx, { state: "idle" });
  emit("agent.progress", ctx, { state: "clear" });
  if (
    event.messages?.some(
      (message) => message.role === "assistant" && message.stopReason === "aborted",
    ) === true
  ) {
    if (abortAlertAlreadyEmitted) return;
    emit("agent.aborted", ctx, { reason: "user", message: "Agent interrupted" });
    return;
  }
  if (!shouldNotifyAgentEnd(childState, ctx)) return;
  const notification = formatNotification(extractLastAssistantText(event.messages ?? []));
  if (notification === null) return;
  emit("agent.alert", ctx, {
    kind: "runtime",
    severity: "success",
    title: boundedText(notification.title, 128),
    body: boundedText(notification.body, 512),
  });
};

const handleProviderResponse = (
  event: { status: number },
  ctx: ExtensionContext,
  emit: (eventName: PiOscV1Event, ctx: ExtensionContext, data: PiOscV1Payload) => void,
): void => {
  if (event.status !== 429) return;
  emit("agent.alert", ctx, {
    kind: "provider",
    severity: "warning",
    title: "Provider rate limit",
    body: "Provider returned HTTP 429.",
    statusCode: event.status,
  });
};

const handleTurnEnd = (
  event: {
    turnIndex: number;
    message?: { role?: string; stopReason?: string; errorMessage?: string };
  },
  ctx: ExtensionContext,
  abortAlertEmitted: boolean,
  emit: (eventName: PiOscV1Event, ctx: ExtensionContext, data: PiOscV1Payload) => void,
): boolean => {
  emit("agent.turn", ctx, { state: "complete", turnIndex: event.turnIndex });
  if (
    event.message?.role !== "assistant" ||
    event.message.stopReason !== "aborted" ||
    abortAlertEmitted
  ) {
    return abortAlertEmitted;
  }
  emit("agent.aborted", ctx, {
    reason: "user",
    message:
      event.message.errorMessage === "Operation aborted"
        ? "Operation aborted"
        : "Agent interrupted",
  });
  return true;
};

type PiOscEmit = (eventName: PiOscV1Event, ctx: ExtensionContext, data: PiOscV1Payload) => void;

const emitQuestionOscEvent = (event: AskUserQuestionEventPayload, seq: number): void => {
  const questionCount = event.questions.length;
  const requiresScreenshot = questionEventRequiresScreenshot(event);
  writePiOscSequence(
    createPiOscSequence("agent.question", {
      id: piOscRuntime.randomId(),
      ts: piOscRuntime.now(),
      source: "agent",
      cwd: event.cwd,
      seq,
      ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
      data: {
        state: questionOscState(event),
        toolCallId: boundedText(event.toolCallId, 128),
        questionCount,
        title: boundedText(questionEventTitle(questionCount), 128),
        body: boundedText(questionEventBody(event), 512),
        ...(requiresScreenshot ? { requiresScreenshot: true } : {}),
        ...(event.glanceUploadUrl === undefined
          ? {}
          : { glanceUploadUrl: boundedText(event.glanceUploadUrl, 2048) }),
      },
    }),
  );
};

const registerRunLifecycleHandlers = (
  pi: ExtensionAPI,
  childState: ReturnType<typeof readChildState>,
  titleSpinner: ReturnType<typeof createTitleSpinnerController>,
  emit: PiOscEmit,
  getAbortAlertEmitted: () => boolean,
  setAbortAlertEmitted: (value: boolean) => void,
): void => {
  pi.on("agent_start", (_event, ctx) => {
    setAbortAlertEmitted(false);
    titleSpinner.start(ctx, "thinking");
    emit("agent.run", ctx, { state: "running" });
    emit("agent.progress", ctx, { state: "active" });
  });

  pi.on("agent_end", (event, ctx) => {
    titleSpinner.stop(ctx);
    handleAgentEnd(event, ctx, childState, emit, getAbortAlertEmitted());
  });

  pi.on("session_shutdown", (_event, ctx) => {
    titleSpinner.stop(ctx);
  });
};

const registerSessionHandlers = (
  pi: ExtensionAPI,
  titleSpinner: ReturnType<typeof createTitleSpinnerController>,
  emit: PiOscEmit,
): void => {
  pi.on("session_start", (event, ctx) => {
    titleSpinner.stop(ctx);
    emit("hello", ctx, { protocol: 1, extension: "pi-osc", version: 1 });
    emit("agent.session", ctx, { state: "started", reason: event.reason });
  });
};

const messageActivity = (
  event: AssistantMessageEvent,
): { titleActivity: TitleActivity; progressLabel: string } | undefined => {
  switch (event.type) {
    case "thinking_start":
    case "thinking_delta":
      return { titleActivity: "thinking", progressLabel: THINKING_LABEL };
    case "text_start":
    case "text_delta":
      return { titleActivity: "responding", progressLabel: "Writing" };
    case "toolcall_start":
    case "toolcall_delta":
      return { titleActivity: "toolcall", progressLabel: "Preparing tool" };
    case "done":
    case "error":
    case "start":
    case "text_end":
    case "thinking_end":
    case "toolcall_end":
      break;
  }
  return undefined;
};

const emitInputSubmitted = (ctx: ExtensionContext, emit: PiOscEmit): { action: "continue" } => {
  emit("agent.input", ctx, { state: "submitted" });
  return { action: "continue" };
};

const registerToolHandlers = (
  pi: ExtensionAPI,
  titleSpinner: ReturnType<typeof createTitleSpinnerController>,
  emit: PiOscEmit,
  activeToolArgs: Map<string, unknown>,
  notifiedInterviewUrls: Set<string>,
): void => {
  const startedToolCalls = new Set<string>();

  const emitToolRunning = (
    toolCallId: string,
    toolName: string,
    args: unknown,
    ctx: ExtensionContext,
  ): void => {
    activeToolArgs.set(toolCallId, args);
    startedToolCalls.add(toolCallId);
    const label = boundedOptionalText(toolLabel(toolName, args), 128);
    emit("agent.tool", ctx, {
      toolCallId: boundedText(toolCallId, 128),
      toolName: boundedText(toolName, 128),
      state: "running",
      ...(label === undefined ? {} : { label }),
    });
  };

  pi.on("tool_call", (event, ctx) => {
    titleSpinner.setActivity(ctx, toolTitleActivity(event.toolName, event.input));
    emitToolRunning(event.toolCallId, event.toolName, event.input, ctx);
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (startedToolCalls.has(event.toolCallId)) return;
    titleSpinner.setActivity(ctx, toolTitleActivity(event.toolName, event.args));
    emitToolRunning(event.toolCallId, event.toolName, event.args, ctx);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    const args = activeToolArgs.get(event.toolCallId);
    activeToolArgs.delete(event.toolCallId);
    startedToolCalls.delete(event.toolCallId);
    if (startedToolCalls.size === 0) {
      titleSpinner.setActivity(ctx, "thinking");
    }
    const label = boundedOptionalText(toolLabel(event.toolName, args), 128);
    const summary = boundedOptionalText(toolSummary(event.toolName, args, event.result), 512);
    emit("agent.tool", ctx, {
      toolCallId: boundedText(event.toolCallId, 128),
      toolName: boundedText(event.toolName, 128),
      state: "complete",
      isError: event.isError,
      ...(label === undefined ? {} : { label }),
      ...(summary === undefined ? {} : { summary }),
    });
  });

  pi.on("tool_execution_update", (event, ctx) => {
    if (event.toolName !== "interview") return;
    const interview = interviewDetailsFromResult(event.partialResult);
    if (interview === undefined || notifiedInterviewUrls.has(interview.url)) return;
    notifiedInterviewUrls.add(interview.url);
    const questionCount =
      interview.totalQuestions === undefined
        ? ""
        : ` · ${interview.totalQuestions} question${interview.totalQuestions === 1 ? "" : "s"}`;
    emit("agent.alert", ctx, {
      kind: "interview",
      severity: "info",
      title: "Interview ready",
      body: boundedText(`${interview.title}${questionCount}. Tap to answer.`, 512),
      url: interview.url,
    });
  });
};

export default function piOscExtension(pi: ExtensionAPI): void {
  const childState = readChildState();
  let seq = 0;
  let goalProgressActive = false;
  let lastThinkingEmittedAt = 0;
  let abortAlertEmitted = false;
  const titleSpinner = createTitleSpinnerController(pi, childState);
  const notifiedInterviewUrls = new Set<string>();
  const activeToolArgs = new Map<string, unknown>();
  const emit = (eventName: PiOscV1Event, ctx: ExtensionContext, data: PiOscV1Payload): void => {
    seq += 1;
    emitPiOscEvent(eventName, ctx, seq, data);
  };

  pi.events.on(GOAL_PROGRESS_EVENT, (event) => {
    if (!Value.Check(GoalProgressEventSchema, event)) {
      return;
    }
    const goalProgress = Value.Parse(GoalProgressEventSchema, event);
    if (goalProgress.status === "clear" && !goalProgressActive) {
      return;
    }
    goalProgressActive = goalProgress.status === "active";
    seq += 1;
    writePiOscSequence(
      createPiOscSequence("agent.progress", {
        id: piOscRuntime.randomId(),
        ts: piOscRuntime.now(),
        source: "agent",
        sessionId: goalProgress.sessionId,
        cwd: goalProgress.cwd,
        seq,
        data:
          goalProgress.status === "active"
            ? {
                state: "active",
                elapsedSeconds: goalProgress.timeUsedSeconds ?? 0,
              }
            : { state: "clear" },
      }),
    );
  });

  const handleAskUserQuestionEvent = (event: unknown): void => {
    if (!isAskUserQuestionEventPayload(event)) return;
    seq += 1;
    emitQuestionOscEvent(event, seq);
  };

  pi.events.on(ASK_USER_QUESTION_PROMPT_EVENT, handleAskUserQuestionEvent);
  pi.events.on(ASK_USER_QUESTION_ANSWERED_EVENT, handleAskUserQuestionEvent);
  pi.events.on(ASK_USER_QUESTION_CANCELLED_EVENT, handleAskUserQuestionEvent);

  registerSessionHandlers(pi, titleSpinner, emit);

  registerRunLifecycleHandlers(
    pi,
    childState,
    titleSpinner,
    emit,
    () => abortAlertEmitted,
    (value) => {
      abortAlertEmitted = value;
    },
  );

  pi.on("input", (_event, ctx) => {
    return emitInputSubmitted(ctx, emit);
  });

  pi.on("turn_start", (event, ctx) => {
    emit("agent.turn", ctx, { state: "running", turnIndex: event.turnIndex });
  });

  pi.on("turn_end", (event, ctx) => {
    abortAlertEmitted = handleTurnEnd(event, ctx, abortAlertEmitted, emit);
  });

  pi.on("message_update", (event, ctx) => {
    const activity = messageActivity(event.assistantMessageEvent);
    if (activity === undefined) return;
    titleSpinner.setActivity(ctx, activity.titleActivity);
    const now = piOscRuntime.now();
    if (now - lastThinkingEmittedAt < THINKING_DEBOUNCE_MS) {
      return;
    }
    lastThinkingEmittedAt = now;
    emit("agent.progress", ctx, { state: "active", label: activity.progressLabel });
  });

  registerToolHandlers(pi, titleSpinner, emit, activeToolArgs, notifiedInterviewUrls);

  pi.on("session_before_compact", (_event, ctx) => {
    titleSpinner.setActivity(ctx, "compacting");
    emit("agent.compaction", ctx, { state: "preparing" });
  });

  pi.on("session_compact", (_event, ctx) => {
    titleSpinner.stop(ctx);
    emit("agent.compaction", ctx, { state: "complete" });
  });

  pi.on("after_provider_response", (event, ctx) => {
    handleProviderResponse(event, ctx, emit);
  });
}
