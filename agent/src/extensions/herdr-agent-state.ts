import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  ASK_USER_QUESTION_ANSWERED_EVENT,
  ASK_USER_QUESTION_CANCELLED_EVENT,
  ASK_USER_QUESTION_PROMPT_EVENT,
  type AskUserQuestionPromptEventPayload,
} from "./ask-user-question/index.js";
import { isAskUserQuestionEventPayload } from "./ask-user-question/events.js";
import { extractLastAssistantText, formatNotification } from "./terminal-notify.js";
import { isChildSession, readChildState } from "../subagent-sdk/index.js";
import type { ChildBootstrapState } from "../subagent-sdk/types.js";
import { asRecord, readString } from "../utils/unknown-data.js";
import {
  HERDR_WINDOW_TITLE_EVENT,
  type HerdrWindowTitleEvent,
} from "./herdr-window-title-events.js";
import {
  customStatusForState,
  messageActivitySummary,
  metadataTokens,
  sessionTabTitle,
  sessionTitle,
  toolActivitySummary,
} from "./herdr-agent-presentation.js";
import {
  currentPaneId,
  currentTabId,
  HERDR_AGENT_SOURCE as source,
  herdrEnabled,
  nextReportSeq,
  randomRequestId,
  sendRequest,
  sendRequestWithResponse,
} from "./herdr-agent-socket.js";

type AgentState = "working" | "blocked" | "idle";

type QueuedState = {
  state: AgentState;
  message?: string;
  seq: number;
};

const retryableErrorPattern =
  /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

let currentAgentSessionId: string | undefined;
let currentAgentSessionPath: string | undefined;

function parseDurationEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
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

function currentSessionRef(): Record<string, unknown> | undefined {
  if (currentAgentSessionPath !== undefined) {
    return { agent_session_path: currentAgentSessionPath };
  }
  if (currentAgentSessionId !== undefined) {
    return { agent_session_id: currentAgentSessionId };
  }
  return undefined;
}

function reportSession(): Promise<void> {
  const paneId = currentPaneId();
  const sessionRef = currentSessionRef();
  if (paneId === undefined || sessionRef === undefined) {
    return Promise.resolve();
  }

  return sendRequest({
    id: randomRequestId("session"),
    method: "pane.report_agent_session",
    params: {
      pane_id: paneId,
      source,
      agent: "pi",
      seq: nextReportSeq(),
      ...sessionRef,
    },
  });
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
      custom_status: customStatusForState(state, message),
      seq,
    }),
  });
}

function sendMetadata(params: Record<string, unknown>): Promise<void> {
  const paneId = currentPaneId();
  if (paneId === undefined) {
    return Promise.resolve();
  }

  return sendRequest({
    id: randomRequestId("metadata"),
    method: "pane.report_metadata",
    params: {
      pane_id: paneId,
      source,
      agent: "pi",
      applies_to_source: source,
      seq: nextReportSeq(),
      ...params,
    },
  });
}

function sendWindowTitle(title: string): Promise<void> {
  return sendRequest({
    id: randomRequestId("window-title"),
    method: "client.window_title.set",
    params: { title },
  });
}

function clearWindowTitle(): Promise<void> {
  return sendRequest({
    id: randomRequestId("clear-window-title"),
    method: "client.window_title.clear",
    params: {},
  });
}

type CurrentPaneContext = {
  focused: boolean;
  tabId: string;
};

async function readCurrentPaneContext(): Promise<CurrentPaneContext | undefined> {
  const paneId = currentPaneId();
  if (paneId === undefined) return undefined;

  const response = await sendRequestWithResponse({
    id: randomRequestId("current-pane"),
    method: "pane.current",
    params: { caller_pane_id: paneId },
  });
  if (response === undefined || "error" in response) return undefined;

  const pane = asRecord(response.result.pane);
  const tabId = readString(pane?.tab_id);
  if (tabId === undefined || typeof pane?.focused !== "boolean") return undefined;
  return { tabId, focused: pane.focused };
}

function renameTab(tabId: string, label: string): Promise<void> {
  return sendRequest({
    id: randomRequestId("tab-title"),
    method: "tab.rename",
    params: { tab_id: tabId, label },
  });
}

async function sendWindowTitleIfFocused(title: string): Promise<void> {
  const pane = await readCurrentPaneContext();
  if (pane?.focused === true) {
    await sendWindowTitle(title);
  }
}

async function clearWindowTitleIfFocused(): Promise<void> {
  const pane = await readCurrentPaneContext();
  if (pane?.focused === true) {
    await clearWindowTitle();
  }
}

function sendNotification(title: string, body?: string, sound: "done" | "request" = "done"): void {
  void sendRequest({
    id: randomRequestId("notification"),
    method: "notification.show",
    params: body === undefined ? { title, sound } : { title, body, sound },
  });
}

function parseWindowTitleEvent(data: unknown): HerdrWindowTitleEvent | undefined {
  const title = readString(asRecord(data)?.title);
  return title === undefined ? undefined : { title };
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

function isMessageLike(value: unknown): value is { role?: string; content?: unknown } {
  const record = asRecord(value);
  return record !== undefined && (record.role === undefined || typeof record.role === "string");
}

function readMessages(event: unknown): Array<{ role?: string; content?: unknown }> | undefined {
  const messages = asRecord(event)?.messages;
  if (!Array.isArray(messages) || !messages.every((message) => isMessageLike(message))) {
    return undefined;
  }
  return messages;
}

function retryableErrorMessage(event: unknown): string | undefined {
  const messages = readMessages(event);
  if (messages === undefined) {
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
  private currentContext: ExtensionContext | undefined;
  private readonly activeQuestionToolCallIds = new Set<string>();
  private rootSession = false;
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
  private queuedWindowTitle: string | undefined;
  private windowTitleInFlight = false;
  private currentSummary = "Ready";
  private currentTool: string | null = null;
  private readonly activeTools = new Map<string, { name: string; summary: string }>();
  private queuedMetadata: Record<string, unknown> | undefined;
  private metadataDrainPromise: Promise<void> | undefined;

  constructor(private readonly childState: ChildBootstrapState | undefined) {}

  register(pi: ExtensionAPI): void {
    pi.on("session_start", (_event, ctx) => {
      this.onSessionStart(ctx);
    });
    pi.on("session_info_changed", async (_event, ctx) => {
      if (!this.rootSession || this.isChildSession(ctx)) return;
      this.currentContext = ctx;
      await this.updateTitle(ctx);
    });
    pi.on("before_agent_start", (_event, ctx) => {
      if (!this.rootSession) return;
      this.currentContext = ctx;
      if (!this.isChildSession(ctx)) {
        void this.updateTitle(ctx);
      }
    });
    pi.events.on("herdr:blocked", (data) => {
      this.onBlockedEvent(data);
    });
    pi.events.on(HERDR_WINDOW_TITLE_EVENT, (data) => {
      if (!this.rootSession || this.isChildSession()) return;
      const event = parseWindowTitleEvent(data);
      if (event !== undefined) {
        this.queueWindowTitle(event.title);
      }
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
    pi.on("agent_start", (_event, ctx) => {
      this.onAgentStart(ctx);
    });
    pi.on("agent_end", (event, ctx) => {
      this.onAgentEnd(event, ctx);
    });
    pi.on("message_update", (event, ctx) => {
      const summary = messageActivitySummary(event.assistantMessageEvent.type);
      if (summary === undefined) return;
      this.currentSummary = summary;
      this.updateActivity(ctx);
    });
    pi.on("tool_call", (event, ctx) => {
      this.onToolStart(event.toolCallId, event.toolName, event.input, ctx);
    });
    pi.on("tool_execution_start", (event, ctx) => {
      this.onToolStart(event.toolCallId, event.toolName, event.args, ctx);
    });
    pi.on("tool_execution_end", (event, ctx) => {
      this.onToolEnd(event.toolCallId, ctx);
    });
    pi.on("model_select", (_event, ctx) => {
      this.updateActivity(ctx);
    });
    pi.on("session_before_compact", (_event, ctx) => {
      this.currentSummary = "Compacting context";
      this.currentTool = null;
      this.updateActivity(ctx);
    });
    pi.on("session_compact", (_event, ctx) => {
      this.currentSummary = this.agentActive ? "Thinking" : "Ready";
      this.updateActivity(ctx);
    });
    pi.on("session_shutdown", async (event) => {
      if (!this.rootSession) return;
      this.clearPendingTimers();
      if (readString(asRecord(event)?.reason) !== "quit") return;
      await Promise.all([
        this.queueMetadata({
          clear_title: true,
          clear_state_labels: true,
          tokens: {
            context: null,
            model: null,
            summary: null,
            tool: null,
          },
        }),
        clearWindowTitleIfFocused(),
        releaseAgent(),
      ]);
    });
  }

  private onSessionStart(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    this.rootSession = true;
    this.currentContext = ctx;
    updateSessionRef(ctx);
    this.agentActive = !ctx.isIdle();
    this.currentSummary = this.agentActive ? "Working" : "Ready";
    if (this.isChildSession(ctx)) {
      void reportSession();
    } else {
      void reportSession();
      void this.updateTitle(ctx);
    }
    this.publishState(true);
  }

  private async updateTitle(ctx: ExtensionContext): Promise<void> {
    const title = sessionTitle(ctx);
    const tabTitle = sessionTabTitle(ctx);
    const tokens = this.metadataTokens(ctx);
    void this.queueMetadata({
      title,
      display_agent: "π",
      tokens,
      state_labels: {
        working: "working",
        blocked: "needs input",
        idle: "ready",
        done: "done",
        unknown: "unknown",
      },
    });
    const pane = await readCurrentPaneContext();
    const tabId = pane?.tabId ?? currentTabId();
    await Promise.all([
      pane?.focused === true ? sendWindowTitle(title) : Promise.resolve(),
      tabId === undefined ? Promise.resolve() : renameTab(tabId, tabTitle),
    ]);
  }

  private metadataTokens(ctx: ExtensionContext) {
    return metadataTokens(ctx, this.currentSummary, this.currentTool);
  }

  private updateActivity(ctx: ExtensionContext): void {
    if (!this.rootSession || this.isChildSession(ctx)) return;
    this.currentContext = ctx;
    void this.queueMetadata({ tokens: this.metadataTokens(ctx) });
  }

  private onToolStart(
    toolCallId: string,
    toolName: string,
    args: unknown,
    ctx: ExtensionContext,
  ): void {
    if (!this.rootSession) return;
    const summary = toolActivitySummary(toolName, args);
    this.activeTools.set(toolCallId, { name: toolName, summary });
    this.currentSummary = summary;
    this.currentTool = toolName;
    this.updateActivity(ctx);
  }

  private onToolEnd(toolCallId: string, ctx: ExtensionContext): void {
    if (!this.rootSession) return;
    this.activeTools.delete(toolCallId);
    const activeTool = [...this.activeTools.values()].at(-1);
    this.currentSummary = activeTool?.summary ?? (this.agentActive ? "Thinking" : "Ready");
    this.currentTool = activeTool?.name ?? null;
    this.updateActivity(ctx);
  }

  private queueMetadata(params: Record<string, unknown>): Promise<void> {
    const queuedTokens = asRecord(this.queuedMetadata?.tokens);
    const nextTokens = asRecord(params.tokens);
    this.queuedMetadata = {
      ...this.queuedMetadata,
      ...params,
      ...(queuedTokens === undefined && nextTokens === undefined
        ? {}
        : { tokens: { ...queuedTokens, ...nextTokens } }),
    };
    this.metadataDrainPromise ??= this.drainMetadataQueue();
    return this.metadataDrainPromise;
  }

  private async drainMetadataQueue(): Promise<void> {
    try {
      while (this.queuedMetadata !== undefined) {
        const metadata = this.queuedMetadata;
        this.queuedMetadata = undefined;
        await sendMetadata(metadata);
      }
    } finally {
      this.metadataDrainPromise = undefined;
      if (this.queuedMetadata !== undefined) {
        this.metadataDrainPromise = this.drainMetadataQueue();
      }
    }
  }

  private queueWindowTitle(title: string): void {
    this.queuedWindowTitle = title;
    if (!this.windowTitleInFlight) {
      void this.drainWindowTitleQueue();
    }
  }

  private async drainWindowTitleQueue(): Promise<void> {
    if (this.windowTitleInFlight) return;

    this.windowTitleInFlight = true;
    try {
      while (this.queuedWindowTitle !== undefined) {
        const title = this.queuedWindowTitle;
        this.queuedWindowTitle = undefined;
        await sendWindowTitleIfFocused(title);
      }
    } finally {
      this.windowTitleInFlight = false;
      if (this.queuedWindowTitle !== undefined) {
        void this.drainWindowTitleQueue();
      }
    }
  }

  private onBlockedEvent(data: unknown): void {
    if (!this.rootSession) return;
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
    this.notifyInputRequest(this.blockedMessage);
    this.publishState();
  }

  private onAskUserQuestionPrompt(data: unknown): void {
    if (!this.rootSession) return;
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
    this.notifyInputRequest(this.blockedMessage);
    this.publishState();
  }

  private onAskUserQuestionResolved(data: unknown): void {
    if (!this.rootSession) return;
    if (!isAskUserQuestionEventPayload(data) || data.type === "prompt") {
      return;
    }
    if (!this.activeQuestionToolCallIds.delete(data.toolCallId)) {
      return;
    }

    this.clearBlocked();
  }

  private onAgentStart(ctx: ExtensionContext): void {
    if (!this.rootSession) return;
    this.currentContext = ctx;
    updateSessionRef(ctx);
    this.clearPendingTimers();
    this.clearFailureState();
    this.agentActive = true;
    this.currentSummary = "Thinking";
    this.currentTool = null;
    this.activeTools.clear();
    this.publishState();
    void reportSession();
    this.updateActivity(ctx);
  }

  private onAgentEnd(event: unknown, ctx: ExtensionContext): void {
    if (!this.rootSession) return;
    if (!this.agentActive) {
      return;
    }

    this.agentActive = false;
    this.currentTool = null;
    this.activeTools.clear();
    const retryableMessage = retryableErrorMessage(event);
    if (retryableMessage !== undefined) {
      this.currentSummary = "Retrying";
      this.updateActivity(ctx);
      this.holdForRetry(retryableMessage);
      return;
    }

    this.currentSummary = "Ready";
    this.updateActivity(ctx);
    this.scheduleIdle();
    this.notifyAgentEnd(event);
  }

  private notifyAgentEnd(event: unknown): void {
    if (this.isChildSession()) {
      return;
    }

    const messages = readMessages(event);
    if (messages === undefined) {
      sendNotification("π", "done", "done");
      return;
    }

    const text = extractLastAssistantText(messages);
    const notification = formatNotification(text);
    if (notification === null) {
      sendNotification("π", "done", "done");
      return;
    }
    sendNotification(notification.title, notification.body, "done");
  }

  private notifyInputRequest(message: string | undefined): void {
    if (this.isChildSession()) {
      return;
    }
    sendNotification("π needs input", message, "request");
  }

  private isChildSession(ctx = this.currentContext): boolean {
    return ctx !== undefined && isChildSession(this.childState, ctx);
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

  new HerdrAgentStateReporter(readChildState()).register(pi);
}
