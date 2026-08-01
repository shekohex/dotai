/* eslint-disable max-lines -- One controller owns the live call state machine and lifecycle. */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
  MessageUpdateEvent,
} from "@earendil-works/pi-coding-agent";
import { buildCodexAttestation, parseCodexDeviceCheckResult } from "./attestation.js";
import {
  assistantFromMessages,
  commentaryFromAssistant,
  emptyAgentResponseReason,
  finalTextFromAssistant,
} from "./agent-response.js";
import {
  applyLiveDiagnosticsSetting,
  applyLiveInstructionsSetting,
  applyLiveVoiceSetting,
} from "./client-settings.js";
import {
  appendLiveDiagnostic,
  configureLiveDiagnostics,
  liveDiagnosticsEnabled,
  LIVE_DIAGNOSTIC_LOG_PATH,
} from "./diagnostics.js";
import {
  buildDelegationContextAppend,
  buildPiSteerContext,
  buildSessionContextAppend,
  buildSessionClose,
  chunkLiveContext,
  type LiveClientMessage,
  type LiveServerEvent,
} from "./protocol.js";
import { AGENT_FINAL_MESSAGE_PREFIX, buildLiveInstructions } from "./prompts.js";
import type { LiveMediaConnection, LivePairingServer } from "./pairing/server.js";
import { CodexLiveControl } from "./transport.js";
import type { LivePhase } from "./visualizer.js";
import { isUnknownRecord } from "../../utils/unknown-value.js";
import type { ResolvedLiveIdentity } from "./settings.js";
import { setLiveDiagnosticsEnabled, setLiveInstructions, setLiveVoice } from "./settings.js";
import {
  buildDelegationWithTranscriptContext,
  LiveConversationTracker,
  prepareLongTranscriptContext,
  type LiveTranscriptContext,
} from "./delegation-context.js";
import { delegationTranscriptRelation } from "./delegation-language.js";
import { LiveAgentProgressBuffer, readLiveAgentDelta } from "./agent-progress.js";
import type {
  LiveCoordinatorEvent,
  LiveSessionCoordinator,
} from "../../live-session/coordinator.js";
import { parseThreadIdParams, parseThreadMessageParams } from "./pairing/server.js";
import { extractMessageText, getConversationMessages } from "../session-launch-utils.js";

const DEFAULT_VOICE = "sol";
const OUTPUT_ACTIVE_LEVEL = 0.015;
const EMPTY_STOP_MAX_RETRIES = 3;
export const LIVE_DELEGATION_MESSAGE_TYPE = "live-delegation";
export const LIVE_TRANSCRIPT_ENTRY_TYPE = "live-transcript";

export interface LiveDelegationMessageDetails {
  delegationId: string;
  sourceTurn: number;
  transcriptRelation: "verbatim" | "synthesized" | "unknown";
  fullTranscriptCharacters?: number;
  fullTranscriptDurationMs?: number;
  conversationContext?: string;
  retryAttempt?: number;
}

interface LiveDelegationExecution {
  request: string;
  details: LiveDelegationMessageDetails;
  retries: number;
}

export interface LiveTranscriptEntryData {
  role: LiveTranscript["role"];
  text: string;
  turn: number;
  timestamp: number;
}

export interface LiveTranscript {
  role: "user" | "assistant";
  text: string;
  turn: number;
  final: boolean;
}

export interface LiveSessionCallbacks {
  onPhase(phase: LivePhase): void;
  onLevels(input: number, output: number): void;
  onTranscript(transcript: LiveTranscript | undefined): void;
  onAgentFailure(message: string): void;
  onTerminal(error?: Error): void;
}

export interface LiveSessionControllerOptions {
  pi: ExtensionAPI;
  context: ExtensionContext;
  pairing: LivePairingServer;
  callbacks: LiveSessionCallbacks;
  identity: ResolvedLiveIdentity;
  appOpenTimeoutMs: number;
  voice?: string;
  customInstructions?: string;
  coordinator: LiveSessionCoordinator;
}

function errorFrom(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function clampLevel(level: number): number {
  if (!Number.isFinite(level) || level <= 0) return 0;
  return Math.min(1, level);
}

function readSdp(value: unknown): string {
  if (!isUnknownRecord(value)) {
    throw new Error("Pi Live app returned an invalid WebRTC response");
  }
  const sdp = value.sdp;
  if (typeof sdp !== "string" || !sdp.trim()) {
    throw new Error("Pi Live app returned an empty SDP");
  }
  if (Buffer.byteLength(sdp) > 256 * 1024) {
    throw new Error("Pi Live app returned an oversized SDP");
  }
  return sdp;
}

function readLevels(value: unknown): { input: number; output: number } | undefined {
  if (!isUnknownRecord(value)) return undefined;
  if (typeof value.input !== "number" || typeof value.output !== "number") return undefined;
  return { input: clampLevel(value.input), output: clampLevel(value.output) };
}

function readWebRtcState(value: unknown): "connecting" | "connected" | "disconnected" | undefined {
  if (!isUnknownRecord(value)) return undefined;
  if (
    value.state === "connecting" ||
    value.state === "connected" ||
    value.state === "disconnected"
  ) {
    return value.state;
  }
  return undefined;
}

/** Coordinates the remote Codex control plane with the macOS media peer and Pi AgentSession. */
export class LiveSessionController {
  readonly #pi: ExtensionAPI;
  readonly #context: ExtensionContext;
  readonly #pairing: LivePairingServer;
  readonly #callbacks: LiveSessionCallbacks;
  readonly #identity: ResolvedLiveIdentity;
  readonly #appOpenTimeoutMs: number;
  readonly #voice: string;
  readonly #customInstructions: string;
  readonly #coordinator: LiveSessionCoordinator;
  #activeVoice: string;
  #activeInstructions: string;
  #diagnosticsEnabled = false;
  #control: CodexLiveControl | undefined;
  #connection: LiveMediaConnection | undefined;
  #sendChain: Promise<void> = Promise.resolve();
  #stopPromise: Promise<void> | undefined;
  #started = false;
  #stopped = false;
  #terminalEmitted = false;
  #failure: Error | undefined;
  #muted = false;
  #phase: LivePhase = "waiting-for-app";
  #activeDelegationId: string | undefined;
  readonly #pendingDelegationIds = new Set<string>();
  readonly #delegationExecutions = new Map<string, LiveDelegationExecution>();
  #lastAgentResponse: AssistantMessage | undefined;
  #mediaOpened = false;
  #outputLevel = 0;
  #mediaOpenResolve: (() => void) | undefined;
  #userTranscript = "";
  #assistantTranscript = "";
  #userTranscriptFinal = false;
  #assistantTranscriptFinal = false;
  #userTranscriptTurn = 0;
  #userTranscriptStartedAt = 0;
  #assistantTranscriptTurn = 0;
  #lastTranscript: LiveTranscript | undefined;
  #sentCommentary = new Set<string>();
  #streamedCommentary = false;
  #streamedSpeakable = false;
  #lastAgentProgress:
    | { delegationId: string; channel: "speakable" | "commentary"; text: string }
    | undefined;
  readonly #spokenSubagentResults = new Map<string, string>();
  #delegationChain: Promise<void> = Promise.resolve();
  readonly #conversation = new LiveConversationTracker();
  readonly #agentProgress: LiveAgentProgressBuffer;
  #unsubscribeCoordinator: (() => void) | undefined;

  constructor(options: LiveSessionControllerOptions) {
    this.#pi = options.pi;
    this.#context = options.context;
    this.#pairing = options.pairing;
    this.#callbacks = options.callbacks;
    this.#identity = options.identity;
    this.#appOpenTimeoutMs = options.appOpenTimeoutMs;
    const voice = options.voice?.trim();
    this.#voice = voice !== undefined && voice.length > 0 ? voice : DEFAULT_VOICE;
    this.#customInstructions = options.customInstructions?.trim() ?? "";
    this.#coordinator = options.coordinator;
    this.#activeVoice = this.#voice;
    this.#activeInstructions = this.#customInstructions;
    this.#agentProgress = new LiveAgentProgressBuffer((progress) => {
      this.#flushAgentProgress(progress.channel, progress.text);
    });
    this.#unsubscribeCoordinator = this.#coordinator.subscribe((event) => {
      this.#handleCoordinatorEvent(event);
    });
  }

  get phase(): LivePhase {
    return this.#phase;
  }

  get muted(): boolean {
    return this.#muted;
  }

  async start(): Promise<void> {
    if (this.#stopped) throw this.#failure ?? new Error("Live session has stopped");
    if (this.#started) return;
    this.#started = true;
    this.#emitPhase("waiting-for-app", true);
    this.#emitTranscript();
    try {
      const connection = await this.#pairing.accept();
      if (this.#stopped) return;
      this.#connection = connection;
      connection.onNotification((method, params) => {
        this.#guardEvent(() => {
          this.#handleAppEvent(method, params);
        });
      });
      connection.onRequest((method, params) => this.#handleAppRequest(method, params));
      connection.onClose((error, clean) => {
        if (this.#stopped) return;
        if (clean === true) void this.stop();
        else this.#reportFailure(error ?? new Error("Pi Live app disconnected"));
      });
      connection.onState((state) => {
        if (this.#stopped) return;
        if (state === "reconnecting") {
          this.#emitPhase("reconnecting");
          return;
        }
        try {
          this.#syncAppConnection();
        } catch (cause) {
          if (connection.open) this.#reportFailure(errorFrom(cause));
        }
        this.#refreshAudioPhase();
      });
      const voice =
        typeof connection.preferredVoice === "string"
          ? setLiveVoice(connection.preferredVoice)
          : this.#voice;
      const customInstructions =
        typeof connection.customInstructions === "string"
          ? setLiveInstructions(connection.customInstructions)
          : this.#customInstructions;
      const diagnosticsEnabled =
        typeof connection.diagnosticsEnabled === "boolean"
          ? setLiveDiagnosticsEnabled(connection.diagnosticsEnabled)
          : liveDiagnosticsEnabled();
      configureLiveDiagnostics(diagnosticsEnabled);
      this.#activeVoice = voice;
      this.#activeInstructions = customInstructions;
      this.#diagnosticsEnabled = diagnosticsEnabled;
      this.#syncAppConnection();
      this.#emitPhase("pairing");
      connection.notify("session.phase", { phase: "pairing" });
      const offerResult = await connection.request("webrtc.createOffer", {
        audio: true,
        dataChannel: "oai-events",
      });
      const offer = readSdp(offerResult);
      const attestationResult = await connection.request("codex.createAttestation");
      const deviceCheck = parseCodexDeviceCheckResult(attestationResult);
      const attestation = buildCodexAttestation(deviceCheck);
      appendLiveDiagnostic(this.#context.sessionManager.getSessionId(), "attestation.created", {
        supported: deviceCheck.supported,
        tokenPresent: deviceCheck.tokenBase64 !== undefined && deviceCheck.tokenBase64.length > 0,
        tokenBytes:
          deviceCheck.tokenBase64 === undefined
            ? 0
            : Buffer.byteLength(deviceCheck.tokenBase64, "base64"),
        latencyMs: deviceCheck.latencyMs,
        envelopeBytes: Buffer.byteLength(attestation),
      });
      this.#emitPhase("connecting");
      const control = new CodexLiveControl({
        attestation,
        context: this.#context,
        sessionId: this.#context.sessionManager.getSessionId(),
        instructions: buildLiveInstructions(this.#identity, customInstructions),
        voice,
        onEvent: (event) => {
          this.#guardEvent(() => {
            this.#handleLiveEvent(event);
          });
        },
      });
      this.#control = control;
      const answer = await control.connect(offer);
      await connection.request("webrtc.acceptAnswer", { sdp: answer });
      await this.#waitForMediaOpen();
      this.#syncCoordinatorState();
      this.#sendSessionSummary();
      if (this.#muted) connection.notify("audio.setMuted", { muted: true });
      this.#refreshAudioPhase();
    } catch (cause) {
      const error = errorFrom(cause);
      appendLiveDiagnostic(this.#context.sessionManager.getSessionId(), "session.failed", {
        phase: this.#phase,
        message: error.message,
      });
      const diagnosedError = new Error(
        liveDiagnosticsEnabled()
          ? `${error.message}\nDiagnostics: ${LIVE_DIAGNOSTIC_LOG_PATH}`
          : error.message,
        { cause: error },
      );
      this.#reportFailure(diagnosedError);
      await this.stop();
      throw diagnosedError;
    }
  }

  toggleMute(): void {
    if (this.#stopped) return;
    this.#muted = !this.#muted;
    this.#notifyApp("audio.setMuted", { muted: this.#muted });
    this.#refreshAudioPhase();
  }

  handleMessageEnd(event: MessageEndEvent): void {
    if (this.#activeDelegationId === undefined || event.message.role !== "assistant") return;
    this.#agentProgress.flush();
    if (this.#streamedCommentary) return;
    const progress = commentaryFromAssistant(event.message);
    if (progress.length === 0 || this.#sentCommentary.has(progress)) return;
    this.#sentCommentary.add(progress);
    const chunks = chunkLiveContext(progress);
    appendLiveDiagnostic(
      this.#context.sessionManager.getSessionId(),
      "agent.commentary-forwarded",
      {
        characters: progress.length,
        chunks: chunks.length,
      },
    );
    for (const chunk of chunks) {
      this.#queueSend(buildDelegationContextAppend(this.#activeDelegationId, chunk, "commentary"));
    }
  }

  handleMessageUpdate(event: MessageUpdateEvent): void {
    if (this.#activeDelegationId === undefined) return;
    const progress = readLiveAgentDelta(event);
    if (progress !== undefined) this.#agentProgress.push(progress);
  }

  handlePiSteer(input: string): void {
    const delegationId = this.#activeDelegationId;
    const context = buildPiSteerContext(input);
    if (delegationId === undefined || context === undefined) return;
    for (const chunk of chunkLiveContext(context)) {
      this.#queueSend(buildDelegationContextAppend(delegationId, chunk, "commentary"));
    }
  }

  handleMessageStart(message: unknown): void {
    if (isUnknownRecord(message) && message.role === "assistant") {
      this.#agentProgress.clear();
      this.#streamedCommentary = false;
      this.#streamedSpeakable = false;
      return;
    }
    if (!isUnknownRecord(message) || message.role !== "custom") return;
    if (message.customType !== LIVE_DELEGATION_MESSAGE_TYPE || !isUnknownRecord(message.details)) {
      return;
    }
    const delegationId = message.details.delegationId;
    if (typeof delegationId !== "string" || delegationId.length === 0) return;
    if (this.#activeDelegationId !== undefined && this.#activeDelegationId !== delegationId) {
      this.#conversation.settleDelegation(this.#activeDelegationId);
      this.#delegationExecutions.delete(this.#activeDelegationId);
    }
    this.#pendingDelegationIds.delete(delegationId);
    this.#activeDelegationId = delegationId;
    this.#lastAgentResponse = undefined;
    this.#sentCommentary.clear();
    this.#agentProgress.clear();
    this.#streamedCommentary = false;
    this.#streamedSpeakable = false;
    this.#lastAgentProgress = undefined;
    this.#emitPhase("working");
  }

  handleAgentEnd(messages: readonly AgentMessage[]): void {
    if (this.#activeDelegationId === undefined) return;
    this.#lastAgentResponse = assistantFromMessages(messages);
  }

  handleAgentSettled(): void {
    const delegationId = this.#activeDelegationId;
    if (delegationId === undefined) return;
    this.#agentProgress.flush();
    const text = this.#lastAgentResponse ? finalTextFromAssistant(this.#lastAgentResponse) : "";
    if (text.length > 0) {
      const finalContext = this.#streamedSpeakable
        ? `${AGENT_FINAL_MESSAGE_PREFIX}The preceding streamed speakable context is the complete final answer. Present any result not already spoken, without repeating earlier progress.`
        : `${AGENT_FINAL_MESSAGE_PREFIX}${text}`;
      for (const chunk of chunkLiveContext(finalContext)) {
        this.#queueSend(buildDelegationContextAppend(delegationId, chunk));
      }
      this.#delegationExecutions.delete(delegationId);
    } else {
      const response = this.#lastAgentResponse;
      const execution = this.#delegationExecutions.get(delegationId);
      if (
        response?.stopReason === "stop" &&
        execution !== undefined &&
        execution.retries < EMPTY_STOP_MAX_RETRIES
      ) {
        this.#retryEmptyDelegation(delegationId, execution, response);
        return;
      }
      const reason = emptyAgentResponseReason(response);
      const message = `Workspace agent stopped without a final response (${reason}).`;
      appendLiveDiagnostic(this.#context.sessionManager.getSessionId(), "delegation.agent-empty", {
        delegationId,
        stopReason: response?.stopReason,
        errorMessage: response?.errorMessage,
      });
      try {
        this.#callbacks.onAgentFailure(message);
      } catch {}
      this.#queueSend(
        buildDelegationContextAppend(
          delegationId,
          `${message} Tell the user the workspace request did not complete and do not claim a result.`,
          "commentary",
        ),
      );
      this.#delegationExecutions.delete(delegationId);
    }
    this.#conversation.settleDelegation(delegationId);
    this.#activeDelegationId = undefined;
    this.#lastAgentResponse = undefined;
    this.#sentCommentary.clear();
    this.#agentProgress.clear();
    this.#streamedCommentary = false;
    this.#streamedSpeakable = false;
    this.#lastAgentProgress = undefined;
    this.#refreshAudioPhase();
  }

  stop(): Promise<void> {
    this.#stopPromise ??= this.#stop();
    return this.#stopPromise;
  }

  async #stop(): Promise<void> {
    this.#stopped = true;
    this.#emitPhaseSafely("ending");
    let cleanupError: Error | undefined;
    await this.#sendChain;
    const control = this.#control;
    this.#control = undefined;
    if (control) {
      try {
        await control.send(buildSessionClose());
      } catch (cause) {
        cleanupError = errorFrom(cause);
      }
      try {
        await control.close();
      } catch (cause) {
        cleanupError ??= errorFrom(cause);
      }
    }
    try {
      this.#connection?.notify("session.stop", { reason: this.#failure ? "error" : "user" });
    } catch {}
    this.#connection?.close();
    this.#connection = undefined;
    this.#agentProgress.clear();
    this.#spokenSubagentResults.clear();
    this.#unsubscribeCoordinator?.();
    this.#unsubscribeCoordinator = undefined;
    this.#conversation.reset();
    await this.#pairing.close();
    if (cleanupError !== undefined) {
      appendLiveDiagnostic(this.#context.sessionManager.getSessionId(), "session.cleanup-warning", {
        message: cleanupError.message,
      });
    }
    this.#emitTerminal(this.#failure);
  }

  #waitForMediaOpen(): Promise<void> {
    if (this.#mediaOpened) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for macOS WebRTC peer"));
      }, this.#appOpenTimeoutMs);
      timeout.unref?.();
      this.#mediaOpenResolve = () => {
        clearTimeout(timeout);
        resolve();
      };
    });
  }

  #handleAppEvent(method: string, params: unknown): void {
    switch (method) {
      case "webrtc.opened":
        this.#mediaOpened = true;
        this.#mediaOpenResolve?.();
        this.#mediaOpenResolve = undefined;
        break;
      case "webrtc.state": {
        const state = readWebRtcState(params);
        if (state === "disconnected") this.#emitPhase("reconnecting");
        else if (state === "connecting") {
          this.#emitPhase(this.#mediaOpened ? "reconnecting" : "connecting");
        } else if (state === "connected") this.#refreshAudioPhase();
        break;
      }
      case "audio.levels": {
        const levels = readLevels(params);
        if (levels) {
          this.#outputLevel = levels.output;
          this.#callbacks.onLevels(levels.input, levels.output);
          this.#refreshAudioPhase();
        }
        break;
      }
      case "audio.muted":
        if (isUnknownRecord(params) && "muted" in params) {
          this.#muted = params.muted === true;
          this.#refreshAudioPhase();
        }
        break;
      case "session.stop":
        void this.stop();
        break;
      case "settings.setVoice":
        this.#notifyApp("settings.voice", applyLiveVoiceSetting(params));
        break;
      case "settings.setInstructions":
        this.#notifyApp("settings.instructions", applyLiveInstructionsSetting(params));
        break;
      case "settings.setDiagnostics":
        this.#notifyApp("settings.diagnostics", applyLiveDiagnosticsSetting(params));
        break;
      case "client.error":
        this.#reportFailure(
          new Error(
            isUnknownRecord(params) && typeof params.message === "string"
              ? params.message
              : "Pi Live app reported an error",
          ),
        );
        break;
      case "pong":
        break;
    }
  }

  #handleAppRequest(method: string, params: unknown): unknown {
    switch (method) {
      case "threads.list":
        return this.#coordinator.snapshot();
      case "threads.inspect": {
        const parsed = parseThreadIdParams(params);
        if (parsed === undefined) throw new Error("Invalid threads.inspect parameters");
        const inspection = this.#coordinator.inspectThread(parsed.threadId);
        if (inspection === undefined) throw new Error(`Unknown thread: ${parsed.threadId}`);
        return inspection;
      }
      case "threads.message": {
        const parsed = parseThreadMessageParams(params);
        if (parsed === undefined) throw new Error("Invalid threads.message parameters");
        return this.#coordinator.messageThread(
          parsed.threadId,
          parsed.message,
          parsed.delivery ?? "steer",
          this.#context,
        );
      }
      case "threads.interrupt": {
        const parsed = parseThreadIdParams(params);
        if (parsed === undefined) throw new Error("Invalid threads.interrupt parameters");
        return this.#coordinator.interruptThread(parsed.threadId);
      }
      default:
        throw new Error(`Unsupported request: ${method}`);
    }
  }

  #handleCoordinatorEvent(event: LiveCoordinatorEvent): void {
    const inspection = this.#coordinator.inspectThread(event.threadId);
    this.#notifyApp(event.type, {
      ...event,
      ...(inspection === undefined ? {} : { thread: inspection.thread }),
    });
    if (
      event.type === "thread.started" ||
      (event.type === "thread.status" &&
        event.data.status !== "completed" &&
        event.data.status !== "failed" &&
        event.data.status !== "cancelled")
    ) {
      this.#spokenSubagentResults.delete(event.threadId);
    }
    if (event.type !== "thread.message" && event.type !== "thread.completed") return;
    let message: string | undefined;
    if (event.type === "thread.message") {
      if (typeof event.data.message === "string") message = event.data.message;
    } else {
      message = inspection?.thread.finalSummary;
    }
    if (message === undefined || message.length === 0) return;
    const normalizedMessage = message.replaceAll(/\s+/g, " ").trim();
    if (event.type === "thread.completed") {
      const spokenResult = this.#spokenSubagentResults.get(event.threadId);
      this.#spokenSubagentResults.delete(event.threadId);
      if (event.data.completionNotificationEnabled === false) return;
      if (spokenResult === normalizedMessage) return;
    } else if (event.data.kind === "result") {
      this.#spokenSubagentResults.set(event.threadId, normalizedMessage);
    }
    const threadPath = inspection?.thread.path ?? event.threadId;
    const context = `<subagent-update thread="${threadPath}" type="${event.type}">\n${message}\n</subagent-update>`;
    for (const chunk of chunkLiveContext(context)) {
      if (this.#activeDelegationId === undefined) {
        this.#queueSend(buildSessionContextAppend(chunk, "speakable"));
      } else {
        this.#queueSend(buildDelegationContextAppend(this.#activeDelegationId, chunk, "speakable"));
      }
    }
  }

  #syncCoordinatorState(): void {
    this.#notifyApp("threads.snapshot", this.#coordinator.snapshot());
  }

  #sendSessionSummary(): void {
    const recent = getConversationMessages(this.#context)
      .filter((message) => message.role === "user" || message.role === "assistant")
      .slice(-2)
      .map((message) => {
        const text = extractMessageText(message.content).replaceAll(/\s+/g, " ").trim();
        return text.length === 0 ? undefined : `${message.role}: ${text.slice(0, 600)}`;
      })
      .filter((line): line is string => line !== undefined);
    const summary = [
      "<live-session-summary>",
      "Brief context for this newly attached voice session. Do not delegate or repeat it verbatim.",
      ...recent,
      this.#coordinator.buildSessionSummary(),
      "</live-session-summary>",
    ].join("\n");
    for (const chunk of chunkLiveContext(summary)) {
      this.#queueSend(buildSessionContextAppend(chunk, "commentary"));
    }
  }

  #handleLiveEvent(event: LiveServerEvent): void {
    switch (event.type) {
      case "session.started":
        if (this.#mediaOpened) this.#refreshAudioPhase();
        break;
      case "session.updated":
      case "output_audio.delta":
      case "unknown":
        break;
      case "input_transcript.added":
        this.#addTranscript("user", event.item.text);
        break;
      case "output_transcript.added":
        this.#addTranscript("assistant", event.item.text);
        break;
      case "turn.done":
        this.#finishTranscript(event.turn.role, event.turn.transcript);
        break;
      case "delegation.created":
        this.#queueDelegation(event);
        break;
      case "error":
        this.#reportFailure(new Error(event.message));
        break;
    }
  }

  #queueDelegation(event: Extract<LiveServerEvent, { type: "delegation.created" }>): void {
    this.#delegationChain = this.#delegationChain
      .then(() => {
        this.#handleDelegation(event);
      })
      .catch((cause) => {
        if (!this.#stopped) this.#reportFailure(errorFrom(cause));
      });
  }

  #handleDelegation(event: Extract<LiveServerEvent, { type: "delegation.created" }>): void {
    let request = "";
    for (const content of event.item.content) {
      if (content.type === "input_text") request += `${request ? "\n" : ""}${content.text}`;
    }
    request = request.trim();
    if (request.length === 0) return;
    const conversationContext = this.#acceptDelegation(event.item.id, request);
    if (conversationContext === undefined) return;
    const sourceTranscript = this.#userTranscript;
    const transcriptDurationMs = this.#currentUserTranscriptDurationMs();
    const transcriptRelation = delegationTranscriptRelation(request, sourceTranscript);
    appendLiveDiagnostic(this.#context.sessionManager.getSessionId(), "delegation.received", {
      delegationId: event.item.id,
      characters: request.length,
      sourceTurn: this.#userTranscriptTurn,
      transcriptRelation,
    });
    const transcriptContext = this.#resolveLongTranscriptContext(
      event.item.id,
      sourceTranscript,
      transcriptDurationMs,
    );
    if (this.#stopped) return;
    const agentRequest = buildDelegationWithTranscriptContext(request, transcriptContext);
    const details = {
      delegationId: event.item.id,
      sourceTurn: this.#userTranscriptTurn,
      transcriptRelation,
      conversationContext,
      ...(transcriptContext === undefined
        ? {}
        : {
            fullTranscriptCharacters: transcriptContext.sourceCharacters,
            fullTranscriptDurationMs: transcriptDurationMs,
          }),
    } satisfies LiveDelegationMessageDetails;
    this.#dispatchDelegation(event.item.id, agentRequest, details);
  }

  #currentUserTranscriptDurationMs(): number {
    return this.#userTranscriptStartedAt === 0 ? 0 : Date.now() - this.#userTranscriptStartedAt;
  }

  #acceptDelegation(delegationId: string, request: string): string | undefined {
    const accepted = this.#conversation.acceptDelegation(request, delegationId);
    if (accepted !== undefined) return accepted.conversationContext;
    appendLiveDiagnostic(this.#context.sessionManager.getSessionId(), "delegation.duplicate", {
      delegationId,
      characters: request.length,
    });
    return undefined;
  }

  #resolveLongTranscriptContext(
    delegationId: string,
    sourceTranscript: string,
    transcriptDurationMs: number,
  ): LiveTranscriptContext | undefined {
    const transcriptContext = prepareLongTranscriptContext(sourceTranscript, transcriptDurationMs);
    if (transcriptContext !== undefined) {
      appendLiveDiagnostic(
        this.#context.sessionManager.getSessionId(),
        "delegation.transcript-attached",
        {
          delegationId,
          sourceCharacters: transcriptContext.sourceCharacters,
          deliveredCharacters: transcriptContext.text.length,
          durationMs: transcriptDurationMs,
        },
      );
    }
    return transcriptContext;
  }

  #dispatchDelegation(
    delegationId: string,
    request: string,
    details: LiveDelegationMessageDetails,
  ): void {
    const agentWasIdle = this.#context.isIdle();
    this.#delegationExecutions.set(delegationId, { request, details, retries: 0 });
    this.#pendingDelegationIds.add(delegationId);
    this.#emitPhase("working");
    appendLiveDiagnostic(this.#context.sessionManager.getSessionId(), "delegation.dispatched", {
      delegationId,
      delivery: agentWasIdle ? "new-turn" : "steer",
    });
    this.#pi.sendMessage(
      {
        customType: LIVE_DELEGATION_MESSAGE_TYPE,
        content: request,
        display: true,
        details,
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  }

  #retryEmptyDelegation(
    delegationId: string,
    execution: LiveDelegationExecution,
    response: AssistantMessage,
  ): void {
    execution.retries += 1;
    const retryRequest = `${execution.request}\n\n<system-injection>\nYou stopped without completing the delegated task. Continue and provide a substantive final answer.\nAttempt #${execution.retries}/${EMPTY_STOP_MAX_RETRIES}\n</system-injection>`;
    this.#activeDelegationId = undefined;
    this.#lastAgentResponse = undefined;
    this.#sentCommentary.clear();
    this.#pendingDelegationIds.add(delegationId);
    this.#emitPhase("working");
    appendLiveDiagnostic(this.#context.sessionManager.getSessionId(), "delegation.empty-retry", {
      delegationId,
      attempt: execution.retries,
      maxAttempts: EMPTY_STOP_MAX_RETRIES,
      stopReason: response.stopReason,
      outputTokens: response.usage?.output,
      contentTypes: response.content.map((content) => content.type),
    });
    this.#pi.sendMessage(
      {
        customType: LIVE_DELEGATION_MESSAGE_TYPE,
        content: retryRequest,
        display: false,
        details: {
          ...execution.details,
          retryAttempt: execution.retries,
        },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  }

  #addTranscript(role: LiveTranscript["role"], text: string): void {
    if (text.length === 0) return;
    const current = role === "user" ? this.#userTranscript : this.#assistantTranscript;
    const wasFinal = role === "user" ? this.#userTranscriptFinal : this.#assistantTranscriptFinal;
    let next: string;
    if (current.length === 0) {
      this.#startTranscriptTurn(role);
      next = text;
    } else if (wasFinal) {
      if (text === current || current.endsWith(text)) return;
      this.#startTranscriptTurn(role);
      next = text;
    } else if (text.startsWith(current)) {
      next = text;
    } else if (current.endsWith(text)) {
      next = current;
    } else {
      next = current + text;
    }
    this.#storeTranscript(role, next, false);
  }

  #finishTranscript(role: LiveTranscript["role"], text: string): void {
    if (text.length === 0) return;
    const current = role === "user" ? this.#userTranscript : this.#assistantTranscript;
    const wasFinal = role === "user" ? this.#userTranscriptFinal : this.#assistantTranscriptFinal;
    if (current.length === 0) this.#startTranscriptTurn(role);
    else if (wasFinal) {
      if (text === current) return;
      this.#startTranscriptTurn(role);
    }
    const next =
      !wasFinal && current.startsWith(text) && current.length > text.length ? current : text;
    if (this.#storeTranscript(role, next, true)) {
      const turn = role === "user" ? this.#userTranscriptTurn : this.#assistantTranscriptTurn;
      appendLiveDiagnostic(this.#context.sessionManager.getSessionId(), "transcript.persisted", {
        role,
        turn,
        characters: next.trim().length,
        llmContext: false,
        triggersTurn: false,
      });
      this.#pi.appendEntry<LiveTranscriptEntryData>(LIVE_TRANSCRIPT_ENTRY_TYPE, {
        role,
        text: next.trim(),
        turn,
        timestamp: Date.now(),
      });
    }
  }

  #startTranscriptTurn(role: LiveTranscript["role"]): void {
    if (role === "user") {
      this.#userTranscriptTurn += 1;
      this.#userTranscriptStartedAt = Date.now();
    } else this.#assistantTranscriptTurn += 1;
  }

  #storeTranscript(role: LiveTranscript["role"], text: string, final: boolean): boolean {
    const normalized = text.trim();
    if (normalized.length === 0) return false;
    const turn = role === "user" ? this.#userTranscriptTurn : this.#assistantTranscriptTurn;
    if (role === "user") {
      this.#userTranscript = normalized;
      this.#userTranscriptFinal = final;
    } else {
      this.#assistantTranscript = normalized;
      this.#assistantTranscriptFinal = final;
    }
    this.#conversation.updateTranscript(role, turn, normalized, final);
    if (
      this.#lastTranscript?.role === role &&
      this.#lastTranscript.turn === turn &&
      this.#lastTranscript.text === normalized &&
      this.#lastTranscript.final === final
    ) {
      return false;
    }
    const transcript = { role, turn, text: normalized, final } satisfies LiveTranscript;
    this.#emitTranscript(transcript);
    this.#notifyApp("transcript.updated", transcript);
    return true;
  }

  #queueSend(message: LiveClientMessage): void {
    const control = this.#control;
    if (!control || this.#stopped) return;
    this.#sendChain = this.#sendChain
      .then(async () => {
        if (!this.#stopped) await control.send(message);
      })
      .catch((cause) => {
        this.#reportFailure(errorFrom(cause));
      });
  }

  #flushAgentProgress(channel: "speakable" | "commentary", text: string): void {
    const delegationId = this.#activeDelegationId;
    if (delegationId === undefined || text.length === 0) return;
    if (channel === "commentary") this.#streamedCommentary = true;
    else this.#streamedSpeakable = true;
    this.#lastAgentProgress = { delegationId, channel, text };
    appendLiveDiagnostic(this.#context.sessionManager.getSessionId(), "agent.progress-forwarded", {
      delegationId,
      channel,
      characters: text.length,
    });
    for (const chunk of chunkLiveContext(text)) {
      this.#queueSend(buildDelegationContextAppend(delegationId, chunk, channel));
    }
    this.#notifyApp("agent.progress", { delegationId, channel, text });
  }

  #syncAppConnection(): void {
    const connection = this.#connection;
    if (connection?.open !== true) return;
    this.#notifyApp("settings.voice", {
      voice: this.#activeVoice,
      saved: true,
      appliesTo: "current",
    });
    this.#notifyApp("settings.instructions", {
      saved: true,
      instructions: this.#activeInstructions,
      appliesTo: "current",
    });
    this.#notifyApp("settings.diagnostics", {
      enabled: this.#diagnosticsEnabled,
      saved: true,
      appliesTo: "current",
    });
    this.#notifyApp("session.phase", { phase: this.#phase });
    this.#notifyApp("audio.setMuted", { muted: this.#muted });
    if (this.#lastTranscript !== undefined) {
      this.#notifyApp("transcript.updated", this.#lastTranscript);
    }
    if (this.#lastAgentProgress !== undefined) {
      this.#notifyApp("agent.progress", this.#lastAgentProgress);
    }
    this.#syncCoordinatorState();
  }

  #notifyApp(method: string, params: unknown): void {
    if (this.#connection?.open !== true) return;
    try {
      this.#connection.notify(method, params);
    } catch {}
  }

  #refreshAudioPhase(): void {
    if (this.#stopped) return;
    if (this.#muted) this.#emitPhase("muted");
    else if (this.#activeDelegationId !== undefined || this.#pendingDelegationIds.size > 0)
      this.#emitPhase("working");
    else if (this.#outputLevel > OUTPUT_ACTIVE_LEVEL) this.#emitPhase("speaking");
    else if (this.#mediaOpened) this.#emitPhase("listening");
    else this.#emitPhase("connecting");
  }

  #guardEvent(handler: () => void): void {
    if (this.#stopped) return;
    try {
      handler();
    } catch (cause) {
      this.#reportFailure(errorFrom(cause));
    }
  }

  #emitPhase(phase: LivePhase, force = false): void {
    if (!force && this.#phase === phase) return;
    this.#phase = phase;
    try {
      this.#callbacks.onPhase(phase);
    } catch (cause) {
      this.#reportFailure(errorFrom(cause));
    }
    this.#notifyApp("session.phase", { phase });
  }

  #emitPhaseSafely(phase: LivePhase): void {
    this.#phase = phase;
    try {
      this.#callbacks.onPhase(phase);
    } catch {}
  }

  #emitTranscript(transcript?: LiveTranscript): void {
    this.#lastTranscript = transcript;
    try {
      this.#callbacks.onTranscript(transcript);
    } catch (cause) {
      this.#reportFailure(errorFrom(cause));
    }
  }

  #reportFailure(error: Error): void {
    if (this.#terminalEmitted || this.#stopped) return;
    this.#failure = error;
    this.#emitPhaseSafely("error");
    this.#emitTerminal(error);
    void this.stop();
  }

  #emitTerminal(error?: Error): void {
    if (this.#terminalEmitted) return;
    this.#terminalEmitted = true;
    try {
      this.#callbacks.onTerminal(error);
    } catch {}
  }
}
