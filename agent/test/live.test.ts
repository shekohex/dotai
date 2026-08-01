import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { buildCodexAttestation } from "../src/extensions/live/attestation.js";
import {
  emptyAgentResponseReason,
  finalTextFromAssistant,
} from "../src/extensions/live/agent-response.js";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { MessageUpdateEvent } from "@earendil-works/pi-coding-agent";
import { _test as liveExtensionTest } from "../src/extensions/live/index.js";
import {
  LiveAgentProgressBuffer,
  readLiveAgentDelta,
} from "../src/extensions/live/agent-progress.js";
import { LivePairingServer } from "../src/extensions/live/pairing/server.js";
import { buildLiveInstructions } from "../src/extensions/live/prompts.js";
import {
  decodePairingUri,
  LIVE_PAIRING_PROTOCOL_VERSION,
} from "../src/extensions/live/pairing/schemas.js";
import {
  buildPiSteerContext,
  chunkLiveContext,
  parseLiveServerEvent,
} from "../src/extensions/live/protocol.js";
import {
  _test as liveTransportTest,
  buildLiveSidebandUrl,
  CodexLiveControl,
  parseLiveCallId,
} from "../src/extensions/live/transport.js";
import {
  defaultLiveSettings,
  normalizeLiveVoice,
  resolveLiveIdentity,
  setLiveDiagnosticsEnabled,
  setLiveInstructions,
  setLiveVoice,
} from "../src/extensions/live/settings.js";
import { LIVE_VOICES } from "../src/extensions/live/voices.js";
import { readAssistantTextPhase } from "../src/utils/pi-ai-text.js";
import { delegationTranscriptRelation } from "../src/extensions/live/delegation-language.js";
import {
  applyLiveDelegationConversationContext,
  omitEmptyLiveDelegationAssistantTurns,
} from "../src/extensions/live/provider-context.js";
import {
  buildDelegationWithTranscriptContext,
  LiveConversationTracker,
  prepareLongTranscriptContext,
} from "../src/extensions/live/delegation-context.js";
import { defaultModes } from "../src/default-modes.js";
import { groupedExtensionsA } from "../src/extensions/definitions-group-a.js";
import { enforceLiveWritePolicy } from "../src/extensions/live/write-policy.js";

const servers: LivePairingServer[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Pi Live pairing", () => {
  it("keeps the one-time secret in the URI fragment", async () => {
    const server = new LivePairingServer({ sessionId: "session-1", mode: "local" });
    servers.push(server);
    const descriptor = await server.start();
    expect(descriptor.uri).toMatch(/^pi-live:\/\/pair#/u);
    expect(descriptor.uri).not.toContain("?token=");
    const decoded = decodePairingUri(descriptor.uri);
    expect(decoded.payload.sessionId).toBe("session-1");
    expect(decoded.secret.length).toBeGreaterThanOrEqual(32);
    expect(decoded.payload.endpoints).toEqual([
      expect.objectContaining({
        type: "local",
        url: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:/u),
      }),
    ]);
  });

  it("accepts one authenticated JSON-RPC controller", async () => {
    const server = new LivePairingServer({ sessionId: "session-2", mode: "local" });
    servers.push(server);
    const descriptor = await server.start();
    const { payload, secret } = decodePairingUri(descriptor.uri);
    const endpoint = payload.endpoints.find((candidate) => candidate.type === "local");
    if (!endpoint || endpoint.type !== "local") throw new Error("Missing local endpoint");
    const accepted = server.accept();
    const socket = new WebSocket(endpoint.url);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "pair",
        method: "pair",
        params: {
          protocolVersion: LIVE_PAIRING_PROTOCOL_VERSION,
          secret,
          client: { name: "test", platform: "macOS", appVersion: "0.1.0" },
          capabilities: {
            webrtc: true,
            inputLevel: false,
            outputLevel: false,
            deviceSelection: false,
            sessionResume: true,
            threadCoordination: true,
          },
          preferences: {
            voice: "maple",
            instructions: "Keep replies especially concise.",
            diagnosticsEnabled: true,
          },
        },
      }),
    );
    const response = await new Promise<Record<string, unknown>>((resolve) => {
      socket.once("message", (data) =>
        resolve(JSON.parse(data.toString()) as Record<string, unknown>),
      );
    });
    expect(response.result).toEqual(expect.objectContaining({ sessionId: "session-2" }));
    const connection = await accepted;
    expect(connection).toMatchObject({
      open: true,
      preferredVoice: "maple",
      customInstructions: "Keep replies especially concise.",
      diagnosticsEnabled: true,
    });
    connection.onRequest((method) => {
      if (method === "threads.list") return { threads: [{ id: "child-1" }] };
      throw new Error(`Unsupported request: ${method}`);
    });
    socket.send(
      JSON.stringify({ jsonrpc: "2.0", id: "threads", method: "threads.list", params: {} }),
    );
    const threadResponse = await new Promise<Record<string, unknown>>((resolve) => {
      socket.once("message", (data) =>
        resolve(JSON.parse(data.toString()) as Record<string, unknown>),
      );
    });
    expect(threadResponse).toMatchObject({
      id: "threads",
      result: { threads: [{ id: "child-1" }] },
    });
    const closed = new Promise<boolean>((resolve) => {
      connection.onClose((_error, clean) => resolve(clean === true));
    });
    socket.close(1000, "done");
    await expect(closed).resolves.toBe(true);
  });

  it("resumes the same logical connection after an unclean transport loss", async () => {
    const server = new LivePairingServer({
      sessionId: "session-resume",
      mode: "local",
      reconnectGraceMs: 1_000,
    });
    servers.push(server);
    const descriptor = await server.start();
    const { payload, secret } = decodePairingUri(descriptor.uri);
    const endpoint = payload.endpoints.find((candidate) => candidate.type === "local");
    if (!endpoint || endpoint.type !== "local") throw new Error("Missing local endpoint");
    const accepted = server.accept();
    const firstSocket = new WebSocket(endpoint.url);
    await new Promise<void>((resolve, reject) => {
      firstSocket.once("open", resolve);
      firstSocket.once("error", reject);
    });
    firstSocket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "pair",
        method: "pair",
        params: {
          protocolVersion: LIVE_PAIRING_PROTOCOL_VERSION,
          secret,
          client: { name: "test", platform: "macOS", appVersion: "0.1.0" },
          capabilities: {
            webrtc: true,
            inputLevel: false,
            outputLevel: false,
            deviceSelection: false,
            sessionResume: true,
            threadCoordination: true,
          },
        },
      }),
    );
    const pairResponse = await new Promise<{
      result: { sessionId: string; serverNonce: string; resumeToken: string };
    }>((resolve) => {
      firstSocket.once("message", (data) => resolve(JSON.parse(data.toString()) as never));
    });
    const connection = await accepted;
    const states: string[] = [];
    let terminated = false;
    connection.onState((state) => states.push(state));
    connection.onClose(() => {
      terminated = true;
    });

    firstSocket.terminate();
    await vi.waitFor(() => expect(states).toContain("reconnecting"));

    const resumedSocket = new WebSocket(endpoint.url);
    await new Promise<void>((resolve, reject) => {
      resumedSocket.once("open", resolve);
      resumedSocket.once("error", reject);
    });
    resumedSocket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "resume",
        method: "resume",
        params: {
          protocolVersion: LIVE_PAIRING_PROTOCOL_VERSION,
          sessionId: pairResponse.result.sessionId,
          serverNonce: pairResponse.result.serverNonce,
          resumeToken: pairResponse.result.resumeToken,
        },
      }),
    );
    const resumeResponse = await new Promise<{ result: { resumed: boolean } }>((resolve) => {
      resumedSocket.once("message", (data) => resolve(JSON.parse(data.toString()) as never));
    });
    expect(resumeResponse.result.resumed).toBe(true);
    await vi.waitFor(() => expect(states).toContain("connected"));
    expect(connection.open).toBe(true);
    expect(terminated).toBe(false);

    const notification = new Promise<Record<string, unknown>>((resolve) => {
      resumedSocket.once("message", (data) =>
        resolve(JSON.parse(data.toString()) as Record<string, unknown>),
      );
    });
    connection.notify("session.phase", { phase: "working" });
    await expect(notification).resolves.toMatchObject({
      method: "session.phase",
      params: { phase: "working" },
    });
    resumedSocket.close(1000, "done");
  });
});

describe("Pi Live agent progress", () => {
  it("classifies thinking and commentary deltas without exposing raw event shapes", () => {
    expect(
      readLiveAgentDelta({
        assistantMessageEvent: { type: "thinking_delta", delta: "Checking", partial: {} },
      } as MessageUpdateEvent),
    ).toEqual({ channel: "commentary", text: "Checking" });
    expect(
      readLiveAgentDelta({
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "Done",
          partial: {
            content: [
              {
                type: "text",
                text: "Done",
                textSignature: JSON.stringify({ v: 1, phase: "final_answer" }),
              },
            ],
          },
        },
      } as MessageUpdateEvent),
    ).toEqual({ channel: "speakable", text: "Done" });
  });

  it("batches token deltas and flushes immediately when the semantic channel changes", () => {
    vi.useFakeTimers();
    try {
      const flushed: Array<{ channel: string; text: string }> = [];
      const buffer = new LiveAgentProgressBuffer((progress) => flushed.push(progress));
      buffer.push({ channel: "commentary", text: "Check" });
      buffer.push({ channel: "commentary", text: "ing" });
      vi.advanceTimersByTime(199);
      expect(flushed).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(flushed).toEqual([{ channel: "commentary", text: "Checking" }]);

      buffer.push({ channel: "commentary", text: "Tests pass" });
      buffer.push({ channel: "speakable", text: "Completed" });
      expect(flushed.at(-1)).toEqual({ channel: "commentary", text: "Tests pass" });
      buffer.flush();
      expect(flushed.at(-1)).toEqual({ channel: "speakable", text: "Completed" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Pi Live Codex protocol", () => {
  it("aborts pending signaling when live control closes", async () => {
    const externalAbortController = new AbortController();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL | Request, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener(
            "abort",
            () => reject(requestSignal?.reason ?? new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }),
    );
    const control = new CodexLiveControl({
      attestation: "attestation",
      context: {
        modelRegistry: {
          getProviderAuth: async () => ({
            auth: { apiKey: "access-token", headers: {} },
            source: "test",
          }),
        },
        sessionManager: { getSessionId: () => "session-1" },
      } as never,
      sessionId: "session-1",
      instructions: "instructions",
      voice: "sol",
      onEvent() {},
      signal: externalAbortController.signal,
    });

    const connecting = control.connect("offer");
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    await control.close();
    const abortedByClose = requestSignal?.aborted;
    externalAbortController.abort();

    await expect(connecting).rejects.toMatchObject({ name: "AbortError" });
    expect(abortedByClose).toBe(true);
  });

  it("rejects oversized signaling responses before WebRTC handoff", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("x".repeat(256 * 1024 + 1), {
            status: 201,
            headers: {
              "content-length": String(256 * 1024 + 1),
              location: "https://api.openai.com/v1/live/rtc_oversized",
            },
          }),
      ),
    );
    const control = new CodexLiveControl({
      attestation: "attestation",
      context: {
        modelRegistry: {
          getProviderAuth: async () => ({
            auth: { apiKey: "access-token", headers: {} },
            source: "test",
          }),
        },
        sessionManager: { getSessionId: () => "session-1" },
      } as never,
      sessionId: "session-1",
      instructions: "instructions",
      voice: "sol",
      onEvent() {},
    });

    await expect(control.connect("offer")).rejects.toThrow(
      "Codex live response exceeded 262144 bytes",
    );
  });

  it("reads pi-ai commentary and final-answer text phases", () => {
    expect(
      readAssistantTextPhase({
        textSignature: JSON.stringify({ v: 1, id: "msg_commentary", phase: "commentary" }),
      }),
    ).toBe("commentary");
    expect(
      readAssistantTextPhase({
        textSignature: JSON.stringify({ v: 1, id: "msg_final", phase: "final_answer" }),
      }),
    ).toBe("final_answer");
    expect(readAssistantTextPhase({ textSignature: "legacy-message-id" })).toBeUndefined();
  });

  it("surfaces empty AgentSession completions instead of treating them as success", () => {
    expect(emptyAgentResponseReason(undefined)).toBe("empty response");
    expect(
      emptyAgentResponseReason({
        stopReason: "error",
        errorMessage: "You have reached your usage limit.",
      } as AssistantMessage),
    ).toBe("You have reached your usage limit.");
    expect(
      emptyAgentResponseReason({
        content: [{ type: "thinking", thinking: "brief" }],
        stopReason: "stop",
        usage: { output: 4 },
      } as AssistantMessage),
    ).toBe("stop · thinking only · 4 output tokens");
  });

  it("uses terminal commentary as a final response when no final-answer phase exists", () => {
    expect(
      finalTextFromAssistant({
        content: [
          {
            type: "text",
            text: "The workspace is clean.",
            textSignature: JSON.stringify({ v: 1, id: "commentary", phase: "commentary" }),
          },
        ],
        stopReason: "stop",
      } as AssistantMessage),
    ).toBe("The workspace is clean.");
  });

  it("omits thinking-only live completion tails from retry context", () => {
    const messages = [
      {
        role: "custom",
        customType: "live-delegation",
        content: "Inspect the workspace",
        display: true,
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "brief" }],
        stopReason: "stop",
        timestamp: 2,
      },
    ] as AgentMessage[];
    expect(omitEmptyLiveDelegationAssistantTurns(messages)).toEqual([messages[0]]);
  });

  it("builds the OMP Codex DeviceCheck attestation envelope", () => {
    expect(
      buildCodexAttestation({
        supported: true,
        tokenBase64: "dGVzdA==",
        latencyMs: 12.5,
        locale: "en-US",
        timezone: "UTC",
        appSessionId: "session-1",
      }),
    ).toBe(
      '{"v":1,"s":0,"t":"v1.pGV0b2tlbmhkR1Z6ZEE9PWlidW5kbGVfaWRwY29tLm9wZW5haS5jb2RleGFmWCanAAEBgWVlbi1VUwJlZW4tVVMDY1VUQwQABQEGaXNlc3Npb24tMWF0-0ApAAAAAAAA"}',
    );
  });

  it("sends Codex attestation with signaling and sideband headers", () => {
    expect(
      liveTransportTest.liveSessionHeaders(
        { accessToken: "access", providerHeaders: {} },
        "session-1",
        "realtime-1",
        "attestation-1",
      ),
    ).toMatchObject({
      Authorization: "Bearer access",
      "x-oai-attestation": "attestation-1",
    });
  });

  it("parses call IDs and sideband URLs", () => {
    expect(parseLiveCallId("https://api.openai.com/v1/live/rtc_abc-123?foo=bar")).toBe(
      "rtc_abc-123",
    );
    expect(buildLiveSidebandUrl("rtc_abc-123")).toBe("wss://api.openai.com/v1/live/rtc_abc-123");
  });

  it("parses delegation events and chunks UTF-8 context", () => {
    expect(
      parseLiveServerEvent({
        type: "delegation.created",
        item: {
          type: "delegation",
          target: "client",
          id: "delegation-1",
          content: [{ type: "input_text", text: "Inspect auth tests" }],
        },
      }),
    ).toEqual(
      expect.objectContaining({
        type: "delegation.created",
        item: expect.objectContaining({ id: "delegation-1" }),
      }),
    );
    expect(
      chunkLiveContext("🙂".repeat(200)).every((chunk) => Buffer.byteLength(chunk) <= 500),
    ).toBe(true);
    expect(buildPiSteerContext("  focus on auth tests  ")).toContain("focus on auth tests");
    expect(buildPiSteerContext(" ")).toBeUndefined();
  });

  it("parses local, SSH, Coder, and direct command adapters", () => {
    expect(liveExtensionTest.parseLiveCommand("local voice=sol")).toMatchObject({
      mode: "local",
      voice: "sol",
    });
    expect(liveExtensionTest.parseLiveCommand("ssh target=pi.coder")).toMatchObject({
      mode: "ssh",
      sshTargetHint: "pi.coder",
    });
    expect(liveExtensionTest.parseLiveCommand("coder")).toMatchObject({ mode: "coder" });
    expect(liveExtensionTest.parseLiveCommand("direct host=10.0.0.2")).toMatchObject({
      mode: "direct",
      directHost: "10.0.0.2",
    });
    expect(liveExtensionTest.parseLiveCommand("local voice=onyx")).toMatchObject({
      mode: "local",
      voice: "sol",
    });
    expect(normalizeLiveVoice("spruce")).toBe("spruce");
    expect(LIVE_VOICES).toEqual([
      "juniper",
      "maple",
      "spruce",
      "ember",
      "vale",
      "breeze",
      "arbor",
      "sol",
      "cove",
    ]);
    expect(() => normalizeLiveVoice("unsupported")).toThrow("Unsupported Pi Live voice");
  });

  it("persists a lowercase client voice without replacing other settings", () => {
    const runtime = mkdtempSync(join(tmpdir(), "pi-live-settings-"));
    temporaryDirectories.push(runtime);
    vi.stubEnv("PI_CODING_AGENT_DIR", runtime);
    writeFileSync(
      join(runtime, "settings.json"),
      JSON.stringify({ recap: { enabled: false }, live: { transport: "ssh", voice: "sol" } }),
    );

    expect(setLiveVoice("Juniper")).toBe("juniper");
    expect(JSON.parse(readFileSync(join(runtime, "settings.json"), "utf8"))).toEqual({
      recap: { enabled: false },
      live: { transport: "ssh", voice: "juniper" },
    });
  });

  it("persists client instructions without replacing other live settings", () => {
    const runtime = mkdtempSync(join(tmpdir(), "pi-live-instructions-"));
    temporaryDirectories.push(runtime);
    vi.stubEnv("PI_CODING_AGENT_DIR", runtime);
    writeFileSync(
      join(runtime, "settings.json"),
      JSON.stringify({ recap: { enabled: false }, live: { transport: "coder", voice: "sol" } }),
    );

    expect(setLiveInstructions("  Keep responses concise.  ")).toBe("Keep responses concise.");
    expect(JSON.parse(readFileSync(join(runtime, "settings.json"), "utf8"))).toEqual({
      recap: { enabled: false },
      live: {
        transport: "coder",
        voice: "sol",
        instructions: "Keep responses concise.",
      },
    });
  });

  it("keeps diagnostics disabled by default and persists client opt-in", () => {
    expect(defaultLiveSettings.diagnosticsEnabled).toBe(false);
    const runtime = mkdtempSync(join(tmpdir(), "pi-live-diagnostics-"));
    temporaryDirectories.push(runtime);
    vi.stubEnv("PI_CODING_AGENT_DIR", runtime);
    writeFileSync(
      join(runtime, "settings.json"),
      JSON.stringify({ recap: { enabled: false }, live: { transport: "coder", voice: "sol" } }),
    );

    expect(setLiveDiagnosticsEnabled(true)).toBe(true);
    expect(JSON.parse(readFileSync(join(runtime, "settings.json"), "utf8"))).toEqual({
      recap: { enabled: false },
      live: { transport: "coder", voice: "sol", diagnosticsEnabled: true },
    });
  });

  it("keeps conversation local and synthesizes English delegations", () => {
    const instructions = buildLiveInstructions(
      {
        firstName: "Shady",
        lastName: "Khalifa",
        username: "shekohex",
        displayName: "Shady Khalifa",
      },
      "Use a warm tone.",
    );
    expect(instructions).toContain("MUST NOT delegate ordinary conversation");
    expect(instructions).toContain("Every client delegation MUST be written in English");
    expect(instructions).toContain("exactly one client delegation");
    expect(instructions).toContain("Arabic conversational prose");
    expect(instructions).toContain("spoken reply MUST use the language of the user's latest turn");
    expect(instructions).toContain("sharp, energetic coworker");
    expect(instructions).toContain("collaborator, not a passive dictation interface");
    expect(instructions).toContain(
      "Clear, well-scoped, reversible work SHOULD be delegated immediately",
    );
    expect(instructions).toContain("Use a warm tone.");
  });

  it("distinguishes copied transcripts from synthesized delegations", () => {
    const transcript = "Check the latest commits in this repository";
    expect(delegationTranscriptRelation(transcript, transcript)).toBe("verbatim");
    expect(
      delegationTranscriptRelation(
        "Inspect recent repository commits and summarize the changes.",
        transcript,
      ),
    ).toBe("synthesized");
    expect(delegationTranscriptRelation(transcript, "")).toBe("unknown");
  });

  it("defines live as an append-mode coordinator with direct orchestration tools", () => {
    expect(defaultModes.modes.live.systemPromptMode).toBe("append");
    expect(defaultModes.modes.live.tools).toEqual(
      expect.arrayContaining(["bash", "subagent", "goal"]),
    );
    expect(defaultModes.modes.live.systemPrompt).toContain("Never perform coding work yourself");
    expect(defaultModes.modes.live.systemPrompt).toContain(
      "Every task and message sent to a child session MUST be concise, self-contained, plain English",
    );
  });

  it("registers Live after Modes so --live starts after mode restoration", () => {
    const extensionIds = groupedExtensionsA.map((extension) => extension.id);
    expect(extensionIds.indexOf("live")).toBeGreaterThan(extensionIds.indexOf("modes"));
  });

  it("limits live-mode direct writes to Markdown inside the workspace", () => {
    expect(enforceLiveWritePolicy("write", { path: "docs/live.md" }, "/workspace")).toBeUndefined();
    expect(enforceLiveWritePolicy("edit", { path: "src/live.ts" }, "/workspace")).toMatchObject({
      block: true,
      reason: expect.stringContaining("src/live.ts"),
    });
    expect(
      enforceLiveWritePolicy(
        "apply_patch",
        { patchText: "*** Begin Patch\n*** Update File: docs/live.md\n*** End Patch" },
        "/workspace",
      ),
    ).toBeUndefined();
    expect(
      enforceLiveWritePolicy(
        "apply_patch",
        {
          patchText:
            "*** Begin Patch\n*** Update File: docs/live.md\n*** Update File: src/live.ts\n*** End Patch",
        },
        "/workspace",
      ),
    ).toMatchObject({ block: true, reason: expect.stringContaining("src/live.ts") });
    expect(
      enforceLiveWritePolicy(
        "apply_patch",
        {
          patchText:
            "*** Begin Patch\n*** Update File: docs/live.md\n*** Move to: src/live.ts\n*** End Patch",
        },
        "/workspace",
      ),
    ).toMatchObject({ block: true, reason: expect.stringContaining("src/live.ts") });
    expect(enforceLiveWritePolicy("write", { path: "../outside.md" }, "/workspace")).toMatchObject({
      block: true,
    });
  });

  it("delivers a long English transcript verbatim with the coding task", () => {
    const transcript = [
      "ENGLISH_CONTEXT_BEGIN",
      ...Array.from({ length: 120 }, (_, index) => `detail-${index}`),
      "ENGLISH_CONTEXT_END",
    ].join(" ");
    const context = prepareLongTranscriptContext(transcript, 61_000);
    const request = buildDelegationWithTranscriptContext(
      "Implement the requested changes.",
      context,
    );

    expect(context?.text).toBe(transcript);
    expect(request).toContain(transcript);
    expect(request).toContain("ENGLISH_CONTEXT_BEGIN");
    expect(request).toContain("ENGLISH_CONTEXT_END");
  });

  it("deduplicates active delegations and allows a repeat after settlement", () => {
    const conversation = new LiveConversationTracker();
    conversation.updateTranscript("user", 1, "Check the server logs");

    expect(conversation.acceptDelegation("Inspect the server logs", "delegation-1")).toEqual({
      conversationContext: "user: Check the server logs\nuser: Inspect the server logs",
    });
    expect(
      conversation.acceptDelegation("Inspect the server logs", "delegation-1"),
    ).toBeUndefined();
    expect(
      conversation.acceptDelegation("Inspect the server logs", "delegation-2"),
    ).toBeUndefined();

    conversation.settleDelegation("delegation-1");
    expect(conversation.acceptDelegation("Inspect the server logs", "delegation-3")).toEqual({
      conversationContext: "user: Inspect the server logs",
    });
  });

  it("carries conversation since the previous workspace handoff", () => {
    const conversation = new LiveConversationTracker();
    conversation.updateTranscript("user", 1, "Check temperatures on the laptop");
    conversation.updateTranscript("assistant", 1, "Do you also want the server?");
    conversation.updateTranscript("user", 2, "Yes, do the same there");

    expect(conversation.acceptDelegation("Check both machines", "delegation-1")).toEqual({
      conversationContext: [
        "user: Check temperatures on the laptop",
        "assistant: Do you also want the server?",
        "user: Yes, do the same there",
        "user: Check both machines",
      ].join("\n"),
    });
    conversation.updateTranscript("assistant", 2, "I sent that to the workspace");
    conversation.updateTranscript("user", 3, "What is the status?");
    expect(conversation.acceptDelegation("Report workspace status", "delegation-2")).toEqual({
      conversationContext: [
        "assistant: I sent that to the workspace",
        "user: What is the status?",
        "user: Report workspace status",
      ].join("\n"),
    });
  });

  it("does not replay a delegated user transcript when its final event arrives late", () => {
    const conversation = new LiveConversationTracker();
    conversation.updateTranscript("user", 1, "Check the logs", false);
    expect(conversation.acceptDelegation("Inspect the logs", "delegation-1")).toBeDefined();

    conversation.updateTranscript("user", 1, "Check the logs", true);
    conversation.updateTranscript("assistant", 1, "I am checking now", true);

    expect(conversation.acceptDelegation("Report current progress", "delegation-2")).toEqual({
      conversationContext: ["assistant: I am checking now", "user: Report current progress"].join(
        "\n",
      ),
    });
  });

  it("adds voice conversation context only to provider-facing delegation content", () => {
    const message = {
      role: "custom" as const,
      customType: "live-delegation",
      content: "Check both machines",
      display: true,
      details: {
        delegationId: "delegation-1",
        sourceTurn: 2,
        transcriptRelation: "synthesized",
        conversationContext: "user: Check temperatures\nuser: Yes, both machines",
      },
      timestamp: 1,
    };

    const messages = applyLiveDelegationConversationContext([message]);

    expect(messages?.[0]).toMatchObject({
      role: "custom",
      content: expect.stringContaining("<live-conversation-context>"),
    });
    expect((messages?.[0] as typeof message).content).toContain("Check both machines");
    expect(message.content).toBe("Check both machines");
  });

  it("preserves the complete long Arabic transcript for coordinator context", () => {
    const transcript = [
      "بداية_السياق",
      ...Array.from({ length: 120 }, (_, index) => `تفصيل-${index}`),
      "نهاية_السياق",
    ].join(" ");
    const context = prepareLongTranscriptContext(transcript, 61_000);
    const request = buildDelegationWithTranscriptContext("Inspect the requested UI flow.", context);

    expect(context?.sourceCharacters).toBe(transcript.length);
    expect(context?.text).toBe(transcript);
    expect(request).toContain(transcript);
    expect(request).toContain("original language");
  });

  it("resolves configurable live identity fields", () => {
    expect(
      resolveLiveIdentity({
        ...defaultLiveSettings.identity,
        firstName: "Shady",
        lastName: "Khalifa",
        username: "shekohex",
      }),
    ).toEqual({
      firstName: "Shady",
      lastName: "Khalifa",
      username: "shekohex",
      displayName: "Shady Khalifa",
    });
  });
});
