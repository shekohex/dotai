import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
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
import { interviewDetailsFromResult, toolLabel, toolSummary } from "./tool-presentations.js";
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
): void => {
  emit("agent.run", ctx, { state: "idle" });
  emit("agent.progress", ctx, { state: "clear" });
  if (
    event.messages?.some(
      (message) => message.role === "assistant" && message.stopReason === "aborted",
    ) === true
  ) {
    emit("agent.alert", ctx, {
      kind: "runtime",
      severity: "warning",
      title: "π",
      body: "Agent interrupted",
    });
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

export default function piOscExtension(pi: ExtensionAPI): void {
  const childState = readChildState();
  let seq = 0;
  let goalProgressActive = false;
  let lastThinkingEmittedAt = 0;
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

  pi.on("session_start", (event, ctx) => {
    emit("hello", ctx, { protocol: 1, extension: "pi-osc", version: 1 });
    emit("agent.session", ctx, { state: "started", reason: event.reason });
  });

  pi.on("agent_start", (_event, ctx) => {
    emit("agent.run", ctx, { state: "running" });
    emit("agent.progress", ctx, { state: "active" });
  });

  pi.on("input", (_event, ctx) => {
    emit("agent.alert", ctx, {
      kind: "input",
      severity: "info",
      title: "π",
      body: "Message submitted",
    });
    return { action: "continue" };
  });

  pi.on("agent_end", (event, ctx) => {
    handleAgentEnd(event, ctx, childState, emit);
  });

  pi.on("turn_start", (event, ctx) => {
    emit("agent.turn", ctx, { state: "running", turnIndex: event.turnIndex });
  });

  pi.on("turn_end", (event, ctx) => {
    emit("agent.turn", ctx, { state: "complete", turnIndex: event.turnIndex });
  });

  pi.on("message_update", (_event, ctx) => {
    const now = piOscRuntime.now();
    if (now - lastThinkingEmittedAt < THINKING_DEBOUNCE_MS) {
      return;
    }
    lastThinkingEmittedAt = now;
    emit("agent.progress", ctx, { state: "active", label: THINKING_LABEL });
  });

  pi.on("tool_execution_start", (event, ctx) => {
    activeToolArgs.set(event.toolCallId, event.args);
    const label = boundedOptionalText(toolLabel(event.toolName, event.args), 128);
    emit("agent.tool", ctx, {
      toolCallId: boundedText(event.toolCallId, 128),
      toolName: boundedText(event.toolName, 128),
      state: "running",
      ...(label === undefined ? {} : { label }),
    });
  });

  pi.on("tool_execution_end", (event, ctx) => {
    const args = activeToolArgs.get(event.toolCallId);
    activeToolArgs.delete(event.toolCallId);
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
    if (event.toolName !== "interview") {
      return;
    }
    const interview = interviewDetailsFromResult(event.partialResult);
    if (interview === undefined || notifiedInterviewUrls.has(interview.url)) {
      return;
    }
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

  pi.on("session_before_compact", (_event, ctx) => {
    emit("agent.compaction", ctx, { state: "preparing" });
  });

  pi.on("session_compact", (_event, ctx) => {
    emit("agent.compaction", ctx, { state: "complete" });
  });

  pi.on("after_provider_response", (event, ctx) => {
    handleProviderResponse(event, ctx, emit);
  });
}
