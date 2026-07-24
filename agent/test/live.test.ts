import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { buildCodexAttestation } from "../src/extensions/live/attestation.js";
import { _test as liveExtensionTest } from "../src/extensions/live/index.js";
import { LivePairingServer } from "../src/extensions/live/pairing/server.js";
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
} from "../src/extensions/live/settings.js";

const servers: LivePairingServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
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
        },
      }),
    );
    const response = await new Promise<Record<string, unknown>>((resolve) => {
      socket.once("message", (data) =>
        resolve(JSON.parse(data.toString()) as Record<string, unknown>),
      );
    });
    expect(response.result).toEqual(expect.objectContaining({ sessionId: "session-2" }));
    await expect(accepted).resolves.toMatchObject({ open: true });
    socket.close();
  });
});

describe("Pi Live Codex protocol", () => {
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
