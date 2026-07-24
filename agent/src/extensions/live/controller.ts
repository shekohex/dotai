import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
} from "@earendil-works/pi-coding-agent";
import { buildCodexAttestation, parseCodexDeviceCheckResult } from "./attestation.js";
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
import { readAssistantTextPhase } from "../../utils/pi-ai-text.js";
import type { ResolvedLiveIdentity } from "./settings.js";
import { setLiveDiagnosticsEnabled, setLiveInstructions, setLiveVoice } from "./settings.js";
import { assessDelegationLanguage, delegationTranscriptRelation } from "./delegation-language.js";
import { normalizeLiveDelegation } from "./delegation-normalizer.js";

const DEFAULT_VOICE = "sol";
const OUTPUT_ACTIVE_LEVEL = 0.015;
export const LIVE_DELEGATION_MESSAGE_TYPE = "live-delegation";
export const LIVE_TRANSCRIPT_ENTRY_TYPE = "live-transcript";
export const LIVE_REJECTED_DELEGATION_ENTRY_TYPE = "live-rejected-delegation";

export interface LiveDelegationMessageDetails {
  delegationId: string;
  sourceTurn: number;
  transcriptRelation: "verbatim" | "synthesized" | "unknown";
  languageAssessment: "english" | "short-ambiguous";
  originalRequest?: string;
  normalizedBy?: string;
}

export interface LiveRejectedDelegationEntryData {
  delegationId: string;
  request: string;
  sourceTurn: number;
  transcriptRelation: "verbatim" | "synthesized" | "unknown";
  detectedLanguage: string;
  reason: "normalization-failed";
  message: string;
  timestamp: number;
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
}

function errorFrom(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function clampLevel(level: number): number {
  if (!Number.isFinite(level) || level <= 0) return 0;
  return Math.min(1, level);
}

function commentaryFromAssistant(message: AssistantMessage): string {
  const commentary = message.content
    .filter(
      (content): content is Extract<(typeof message.content)[number], { type: "text" }> =>
        content.type === "text" && readAssistantTextPhase(content) === "commentary",
    )
    .map((content) => content.text)
    .join("\n")
    .trim();
  if (commentary.length > 0) return commentary;
  if (message.stopReason !== "toolUse") return "";
  return message.content
    .filter(
      (content): content is Extract<(typeof message.content)[number], { type: "text" }> =>
        content.type === "text" && readAssistantTextPhase(content) !== "final_answer",
    )
    .map((content) => content.text)
    .join("\n")
    .trim();
}

function finalTextFromAssistant(message: AssistantMessage): string {
  const finalAnswer = message.content
    .filter(
      (content): content is Extract<(typeof message.content)[number], { type: "text" }> =>
        content.type === "text" && readAssistantTextPhase(content) === "final_answer",
    )
    .map((content) => content.text)
    .join("\n")
    .trim();
  if (finalAnswer.length > 0) return finalAnswer;
  return message.content
    .filter(
      (content): content is Extract<(typeof message.content)[number], { type: "text" }> =>
        content.type === "text" && readAssistantTextPhase(content) !== "commentary",
    )
    .map((content) => content.text)
    .join("\n")
    .trim();
}

function assistantFromMessages(messages: readonly AgentMessage[]): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

function readSdp(value: unknown): string {
  if (!isUnknownRecord(value)) {
    throw new Error("Pi Live app returned an invalid WebRTC response");
  }
  const sdp = value.sdp;
  if (typeof sdp !== "string" || !sdp.trim()) {
    throw new Error("Pi Live app returned an empty SDP");
  }
  return sdp;
}

function readLevels(value: unknown): { input: number; output: number } | undefined {
  if (!isUnknownRecord(value)) return undefined;
  if (typeof value.input !== "number" || typeof value.output !== "number") return undefined;
  return { input: clampLevel(value.input), output: clampLevel(value.output) };
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
  #lastAgentResponse: AssistantMessage | undefined;
  #mediaOpened = false;
  #outputLevel = 0;
  #mediaOpenResolve: (() => void) | undefined;
  #userTranscript = "";
  #assistantTranscript = "";
  #userTranscriptFinal = false;
  #assistantTranscriptFinal = false;
  #userTranscriptTurn = 0;
  #assistantTranscriptTurn = 0;
  #lastTranscript: LiveTranscript | undefined;
  #sentCommentary = new Set<string>();
  #delegationChain: Promise<void> = Promise.resolve();

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
      connection.onClose((error, clean) => {
        if (this.#stopped) return;
        if (clean === true) void this.stop();
        else this.#reportFailure(error ?? new Error("Pi Live app disconnected"));
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
      connection.notify("settings.voice", { voice, saved: true, appliesTo: "current" });
      connection.notify("settings.instructions", {
        saved: true,
        instructions: customInstructions,
        appliesTo: "current",
      });
      connection.notify("settings.diagnostics", {
        enabled: diagnosticsEnabled,
        saved: true,
        appliesTo: "current",
      });
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
    try {
      this.#connection?.notify("audio.setMuted", { muted: this.#muted });
    } catch (cause) {
      this.#reportFailure(errorFrom(cause));
    }
    this.#refreshAudioPhase();
  }

  handleMessageEnd(event: MessageEndEvent): void {
    if (this.#activeDelegationId === undefined || event.message.role !== "assistant") return;
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

  handleAgentEnd(messages: readonly AgentMessage[]): void {
    this.#lastAgentResponse = assistantFromMessages(messages);
  }

  handleAgentSettled(): void {
    const delegationId = this.#activeDelegationId;
    if (delegationId === undefined) return;
    const text = this.#lastAgentResponse ? finalTextFromAssistant(this.#lastAgentResponse) : "";
    if (text.length > 0) {
      for (const chunk of chunkLiveContext(`${AGENT_FINAL_MESSAGE_PREFIX}${text}`)) {
        this.#queueSend(buildDelegationContextAppend(delegationId, chunk));
      }
    }
    this.#activeDelegationId = undefined;
    this.#lastAgentResponse = undefined;
    this.#sentCommentary.clear();
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
        this.#connection?.notify("settings.voice", applyLiveVoiceSetting(params));
        break;
      case "settings.setInstructions":
        this.#connection?.notify("settings.instructions", applyLiveInstructionsSetting(params));
        break;
      case "settings.setDiagnostics":
        this.#connection?.notify("settings.diagnostics", applyLiveDiagnosticsSetting(params));
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
      .then(async () => {
        await this.#handleDelegation(event);
      })
      .catch((cause) => {
        if (!this.#stopped) this.#reportFailure(errorFrom(cause));
      });
  }

  async #handleDelegation(
    event: Extract<LiveServerEvent, { type: "delegation.created" }>,
  ): Promise<void> {
    let request = "";
    for (const content of event.item.content) {
      if (content.type === "input_text") request += `${request ? "\n" : ""}${content.text}`;
    }
    request = request.trim();
    if (request.length === 0) return;
    const transcriptRelation = delegationTranscriptRelation(request, this.#userTranscript);
    const language = assessDelegationLanguage(request);
    appendLiveDiagnostic(this.#context.sessionManager.getSessionId(), "delegation.received", {
      delegationId: event.item.id,
      characters: request.length,
      sourceTurn: this.#userTranscriptTurn,
      transcriptRelation,
      detectedLanguage: language.detectedLanguage,
      englishScore: language.englishScore,
      accepted: language.accepted,
    });
    let agentRequest = request;
    let normalizedBy: string | undefined;
    if (language.accepted) {
      appendLiveDiagnostic(
        this.#context.sessionManager.getSessionId(),
        "delegation.normalization-bypassed",
        {
          delegationId: event.item.id,
          reason: language.reason,
        },
      );
    } else {
      appendLiveDiagnostic(this.#context.sessionManager.getSessionId(), "delegation.normalizing", {
        delegationId: event.item.id,
        detectedLanguage: language.detectedLanguage,
        characters: request.length,
      });
      try {
        const normalized = await normalizeLiveDelegation(
          request,
          this.#context,
          (name, details) => {
            appendLiveDiagnostic(this.#context.sessionManager.getSessionId(), name, {
              delegationId: event.item.id,
              ...details,
            });
          },
        );
        if (this.#stopped) return;
        agentRequest = normalized.request;
        normalizedBy = normalized.model;
        appendLiveDiagnostic(this.#context.sessionManager.getSessionId(), "delegation.normalized", {
          delegationId: event.item.id,
          model: normalized.model,
          durationMs: normalized.durationMs,
          sourceCharacters: request.length,
          normalizedCharacters: agentRequest.length,
        });
      } catch (cause) {
        const error = errorFrom(cause);
        if (this.#stopped) return;
        this.#pi.appendEntry<LiveRejectedDelegationEntryData>(LIVE_REJECTED_DELEGATION_ENTRY_TYPE, {
          delegationId: event.item.id,
          request,
          sourceTurn: this.#userTranscriptTurn,
          transcriptRelation,
          detectedLanguage: language.detectedLanguage,
          reason: "normalization-failed",
          message: error.message,
          timestamp: Date.now(),
        });
        appendLiveDiagnostic(
          this.#context.sessionManager.getSessionId(),
          "delegation.normalization-failed",
          {
            delegationId: event.item.id,
            detectedLanguage: language.detectedLanguage,
            message: error.message,
          },
        );
        this.#queueSend(
          buildDelegationContextAppend(
            event.item.id,
            "The client could not normalize this delegation for execution. Briefly tell the user that the workspace request could not be started and ask them to try again. Do not claim that any work was performed.",
            "commentary",
          ),
        );
        this.#refreshAudioPhase();
        return;
      }
    }
    this.#activeDelegationId = event.item.id;
    this.#sentCommentary.clear();
    this.#emitPhase("working");
    this.#pi.sendMessage(
      {
        customType: LIVE_DELEGATION_MESSAGE_TYPE,
        content: agentRequest,
        display: true,
        details: {
          delegationId: event.item.id,
          sourceTurn: this.#userTranscriptTurn,
          transcriptRelation,
          languageAssessment: language.accepted ? language.reason : "english",
          ...(normalizedBy === undefined ? {} : { originalRequest: request, normalizedBy }),
        } satisfies LiveDelegationMessageDetails,
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
    if (role === "user") this.#userTranscriptTurn += 1;
    else this.#assistantTranscriptTurn += 1;
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
    try {
      this.#connection?.notify("transcript.updated", transcript);
    } catch {}
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

  #refreshAudioPhase(): void {
    if (this.#stopped) return;
    if (this.#muted) this.#emitPhase("muted");
    else if (this.#activeDelegationId !== undefined) this.#emitPhase("working");
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
      this.#connection?.notify("session.phase", { phase });
    } catch (cause) {
      this.#reportFailure(errorFrom(cause));
    }
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
