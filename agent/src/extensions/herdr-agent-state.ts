import { createConnection } from "node:net";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  ASK_USER_QUESTION_ANSWERED_EVENT,
  ASK_USER_QUESTION_CANCELLED_EVENT,
  ASK_USER_QUESTION_PROMPT_EVENT,
  type AskUserQuestionPromptEventPayload,
} from "./ask-user-question/index.js";
import { isAskUserQuestionEventPayload } from "./ask-user-question/events.js";
import { asRecord, readString } from "../utils/unknown-data.js";

type AgentState = "working" | "blocked" | "idle";

type QueuedState = {
  state: AgentState;
  message?: string;
  seq: number;
};

type HerdrStateRequest = {
  id: string;
  method: "pane.report_agent" | "pane.release_agent";
  params: Record<string, unknown>;
};

const source = "herdr:pi";
const retryableErrorPattern =
  /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

let reportSeq = Date.now() * 1000;
let currentAgentSessionId: string | undefined;
let currentAgentSessionPath: string | undefined;

function nextReportSeq(): number {
  reportSeq += 1;
  return reportSeq;
}

function parseDurationEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function herdrEnabled(): boolean {
  return (
    process.env.PI_HERDR_AGENT_STATE !== "0" &&
    process.env.HERDR_ENV === "1" &&
    readString(process.env.HERDR_SOCKET_PATH) !== undefined &&
    readString(process.env.HERDR_PANE_ID) !== undefined
  );
}

function currentSocketPath(): string | undefined {
  return herdrEnabled() ? process.env.HERDR_SOCKET_PATH : undefined;
}

function currentPaneId(): string | undefined {
  return herdrEnabled() ? process.env.HERDR_PANE_ID : undefined;
}

function randomRequestId(kind: string): string {
  return `${source}:${kind}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function sendRequest(request: HerdrStateRequest): Promise<void> {
  const socketPath = currentSocketPath();
  if (socketPath === undefined) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve();
    };

    socket.on("error", finish);
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", finish);
    socket.on("end", finish);
    const timeout = setTimeout(finish, 500);
    timeout.unref?.();
  });
}

function updateSessionRef(ctx: ExtensionContext): void {
  try {
    const file = ctx.sessionManager.getSessionFile();
    currentAgentSessionPath = file !== undefined && file.startsWith("/") ? file : undefined;
  } catch {
    currentAgentSessionPath = undefined;
  }

  try {
    const id = ctx.sessionManager.getSessionId();
    currentAgentSessionId = id.length > 0 ? id : undefined;
  } catch {
    currentAgentSessionId = undefined;
  }
}

function withSessionRef(params: Record<string, unknown>): Record<string, unknown> {
  if (currentAgentSessionPath !== undefined) {
    return { ...params, agent_session_path: currentAgentSessionPath };
  }
  if (currentAgentSessionId !== undefined) {
    return { ...params, agent_session_id: currentAgentSessionId };
  }
  return params;
}

function sendState(state: AgentState, message?: string, seq = nextReportSeq()): Promise<void> {
  const paneId = currentPaneId();
  if (paneId === undefined) {
    return Promise.resolve();
  }

  return sendRequest({
    id: randomRequestId("state"),
    method: "pane.report_agent",
    params: withSessionRef({
      pane_id: paneId,
      source,
      agent: "pi",
      state,
      message,
      seq,
    }),
  });
}

function releaseAgent(): Promise<void> {
  const paneId = currentPaneId();
  if (paneId === undefined) {
    return Promise.resolve();
  }

  return sendRequest({
    id: randomRequestId("release"),
    method: "pane.release_agent",
    params: {
      pane_id: paneId,
      source,
      agent: "pi",
      seq: nextReportSeq(),
    },
  });
}

function lastAssistantMessage(messages: unknown[]): Record<string, unknown> | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (message?.role === "assistant") {
      return message;
    }
  }
  return undefined;
}

function retryableErrorMessage(event: unknown): string | undefined {
  const messages = asRecord(event)?.messages;
  if (!Array.isArray(messages)) {
    return undefined;
  }

  const assistant = lastAssistantMessage(messages);
  if (assistant?.stopReason !== "error") {
    return undefined;
  }

  const errorMessage = readString(assistant.errorMessage) ?? "";
  if (!retryableErrorPattern.test(errorMessage)) {
    return undefined;
  }
  return errorMessage.length > 0 ? errorMessage : "retryable provider error";
}

function parseBlockedEvent(data: unknown): { active: boolean; label?: string } | undefined {
  const event = asRecord(data);
  if (event === undefined || typeof event.active !== "boolean") {
    return undefined;
  }
  const label = readString(event.label);
  return label === undefined ? { active: event.active } : { active: event.active, label };
}

function askUserQuestionMessage(event: AskUserQuestionPromptEventPayload): string {
  const [question] = event.questions;
  if (question === undefined) {
    return "question";
  }
  return question.header.length > 0 ? `question: ${question.header}` : "question";
}

function clearTimer(timer: ReturnType<typeof setTimeout> | undefined): void {
  if (timer !== undefined) {
    clearTimeout(timer);
  }
}

class HerdrAgentStateReporter {
  private readonly idleDebounceMs = parseDurationEnv("HERDR_PI_IDLE_DEBOUNCE_MS", 250);
  private readonly retryGraceMs = parseDurationEnv("HERDR_PI_RETRY_GRACE_MS", 2500);
  private readonly activeQuestionToolCallIds = new Set<string>();
  private agentActive = false;
  private retryHoldActive = false;
  private failureBlocked = false;
  private failureMessage: string | undefined;
  private blockedCount = 0;
  private blockedMessage: string | undefined;
  private lastState: AgentState | undefined;
  private lastMessage: string | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private sendInFlight = false;
  private queuedState: QueuedState | undefined;

  register(pi: ExtensionAPI): void {
    pi.on("session_start", (_event, ctx) => {
      this.onSessionStart(ctx);
    });
    pi.events.on("herdr:blocked", (data) => {
      this.onBlockedEvent(data);
    });
    pi.events.on(ASK_USER_QUESTION_PROMPT_EVENT, (data) => {
      this.onAskUserQuestionPrompt(data);
    });
    pi.events.on(ASK_USER_QUESTION_ANSWERED_EVENT, (data) => {
      this.onAskUserQuestionResolved(data);
    });
    pi.events.on(ASK_USER_QUESTION_CANCELLED_EVENT, (data) => {
      this.onAskUserQuestionResolved(data);
    });
    pi.on("agent_start", () => {
      this.onAgentStart();
    });
    pi.on("agent_end", (event) => {
      this.onAgentEnd(event);
    });
    pi.on("session_shutdown", async () => {
      this.clearPendingTimers();
      await releaseAgent();
    });
  }

  private onSessionStart(ctx: ExtensionContext): void {
    updateSessionRef(ctx);
    this.publishState(true);
  }

  private onBlockedEvent(data: unknown): void {
    const event = parseBlockedEvent(data);
    if (event === undefined) {
      return;
    }

    if (!event.active) {
      this.clearBlocked();
      return;
    }

    this.clearPendingTimers();
    this.blockedCount += 1;
    this.blockedMessage = event.label;
    this.publishState();
  }

  private onAskUserQuestionPrompt(data: unknown): void {
    if (!isAskUserQuestionEventPayload(data) || data.type !== "prompt") {
      return;
    }
    if (this.activeQuestionToolCallIds.has(data.toolCallId)) {
      this.blockedMessage = askUserQuestionMessage(data);
      this.publishState();
      return;
    }

    this.clearPendingTimers();
    this.activeQuestionToolCallIds.add(data.toolCallId);
    this.blockedCount += 1;
    this.blockedMessage = askUserQuestionMessage(data);
    this.publishState();
  }

  private onAskUserQuestionResolved(data: unknown): void {
    if (!isAskUserQuestionEventPayload(data) || data.type === "prompt") {
      return;
    }
    if (!this.activeQuestionToolCallIds.delete(data.toolCallId)) {
      return;
    }

    this.clearBlocked();
  }

  private onAgentStart(): void {
    this.clearPendingTimers();
    this.clearFailureState();
    this.agentActive = true;
    this.publishState();
  }

  private onAgentEnd(event: unknown): void {
    if (!this.agentActive) {
      return;
    }

    this.agentActive = false;
    const retryableMessage = retryableErrorMessage(event);
    if (retryableMessage !== undefined) {
      this.holdForRetry(retryableMessage);
      return;
    }

    this.scheduleIdle();
  }

  private clearBlocked(): void {
    this.blockedCount = Math.max(0, this.blockedCount - 1);
    if (this.blockedCount === 0) {
      this.blockedMessage = undefined;
    }
    this.publishState();
  }

  private clearPendingTimers(): void {
    clearTimer(this.idleTimer);
    clearTimer(this.retryTimer);
    this.idleTimer = undefined;
    this.retryTimer = undefined;
  }

  private clearFailureState(): void {
    this.retryHoldActive = false;
    this.failureBlocked = false;
    this.failureMessage = undefined;
  }

  private desiredState(): { state: AgentState; message?: string } {
    if (this.blockedCount > 0) {
      return { state: "blocked", message: this.blockedMessage };
    }
    if (this.failureBlocked) {
      return { state: "blocked", message: this.failureMessage };
    }
    if (this.agentActive || this.retryHoldActive) {
      return { state: "working" };
    }
    return { state: "idle" };
  }

  private queueState(state: AgentState, message?: string): void {
    this.queuedState = { state, message, seq: nextReportSeq() };
    if (!this.sendInFlight) {
      void this.drainStateQueue();
    }
  }

  private async drainStateQueue(): Promise<void> {
    if (this.sendInFlight) {
      return;
    }

    this.sendInFlight = true;
    try {
      while (this.queuedState !== undefined) {
        const next = this.queuedState;
        this.queuedState = undefined;
        await sendState(next.state, next.message, next.seq);
      }
    } finally {
      this.sendInFlight = false;
      if (this.queuedState !== undefined) {
        void this.drainStateQueue();
      }
    }
  }

  private publishState(force = false): void {
    const next = this.desiredState();
    if (!force && next.state === this.lastState && next.message === this.lastMessage) {
      return;
    }
    this.lastState = next.state;
    this.lastMessage = next.message;
    this.queueState(next.state, next.message);
  }

  private scheduleIdle(): void {
    this.clearPendingTimers();
    this.clearFailureState();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      this.publishState();
    }, this.idleDebounceMs);
    this.idleTimer.unref?.();
  }

  private holdForRetry(message: string): void {
    this.clearPendingTimers();
    this.retryHoldActive = true;
    this.failureBlocked = false;
    this.failureMessage = message;
    this.publishState();

    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.retryHoldActive = false;
      this.failureBlocked = true;
      this.publishState();
    }, this.retryGraceMs);
    this.retryTimer.unref?.();
  }
}

export default function herdrAgentStateExtension(pi: ExtensionAPI): void {
  if (!herdrEnabled()) {
    return;
  }

  new HerdrAgentStateReporter().register(pi);
}
