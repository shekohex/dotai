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
import { _test as liveExtensionTest } from "../src/extensions/live/index.js";
import { LivePairingServer } from "../src/extensions/live/pairing/server.js";
import { buildLiveInstructions } from "../src/extensions/live/prompts.js";
import {
  decodePairingUri,
  LIVE_PAIRING_PROTOCOL_VERSION,
} from "../src/extensions/live/pairing/schemas.js";
import { chunkLiveContext, parseLiveServerEvent } from "../src/extensions/live/protocol.js";
import {
  _test as liveTransportTest,
  buildLiveSidebandUrl,
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
import {
  assessDelegationLanguage,
  delegationTranscriptRelation,
} from "../src/extensions/live/delegation-language.js";
import {
  buildDelegationNormalizerInput,
  LIVE_DELEGATION_NORMALIZER_MODELS,
  sanitizeNormalizedDelegation,
} from "../src/extensions/live/delegation-normalizer.js";
import {
  omitEmptyLiveDelegationAssistantTurns,
  promoteLiveDelegationsInOpenAIResponsesPayload,
} from "../src/extensions/live/provider-context.js";

const servers: LivePairingServer[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true });
  vi.unstubAllEnvs();
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
    const closed = new Promise<boolean>((resolve) => {
      connection.onClose((_error, clean) => resolve(clean === true));
    });
    socket.close(1000, "done");
    await expect(closed).resolves.toBe(true);
  });
});

describe("Pi Live Codex protocol", () => {
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

  it("promotes live delegation requests to OpenAI developer messages", () => {
    const request = "Inspect the latest workspace changes.";
    const result = promoteLiveDelegationsInOpenAIResponsesPayload(
      {
        model: "gpt-5.6-sol",
        input: [
          { role: "developer", content: "system" },
          { role: "user", content: [{ type: "input_text", text: request }] },
          { role: "user", content: [{ type: "input_text", text: "ordinary user message" }] },
        ],
      },
      new Set([request]),
    );
    expect(result.promoted).toBe(1);
    expect(result.payload).toMatchObject({
      input: [
        { role: "developer" },
        { role: "developer", content: [{ type: "input_text", text: request }] },
        { role: "user" },
      ],
    });
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
    expect(instructions).toContain("spoken reply MUST use the language of the user's latest turn");
    expect(instructions).toContain("Use a warm tone.");
  });

  it("blocks non-English live delegations before AgentSession delivery", () => {
    expect(
      assessDelegationLanguage(
        "Inspect the latest commits in this repository and summarize the recent work.",
      ),
    ).toMatchObject({ accepted: true });
    expect(
      assessDelegationLanguage(
        "تمام، قولي كده سريعاً عن المشروع ده إيه الأخبار، يعني آخر كوميتس حصلت فيه؟",
      ),
    ).toMatchObject({ accepted: false, detectedLanguage: "arb" });
    expect(
      assessDelegationLanguage(
        "Revisa los últimos commits del proyecto y resume los cambios recientes.",
      ),
    ).toMatchObject({ accepted: false, detectedLanguage: "spa" });
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

  it("prefers fast helper models and sanitizes normalized delegations", () => {
    expect(LIVE_DELEGATION_NORMALIZER_MODELS.slice(0, 3)).toEqual([
      { provider: "codex-openai", model: "gpt-5.4-mini" },
      { provider: "opencode-go", model: "deepseek-v4-flash" },
      { provider: "deepseek", model: "deepseek-v4-flash" },
    ]);
    expect(buildDelegationNormalizerInput("  مرحبا  ")).toContain("<source-delegation>\nمرحبا");
    expect(sanitizeNormalizedDelegation('English task: "Inspect the latest commits."')).toBe(
      "Inspect the latest commits.",
    );
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
