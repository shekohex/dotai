import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Api, AssistantMessage, ImageContent, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { LivePairingServer } from "../src/extensions/live/pairing/server.js";
import {
  decodePairingUri,
  LIVE_PAIRING_PROTOCOL_VERSION,
} from "../src/extensions/live/pairing/schemas.js";
import {
  createLookAtToolDefinition,
  LiveScreenCaptureSession,
  MAX_CAPTURE_IMAGE_BYTES,
  MAX_SCREEN_CAPTURE_FRAME_BYTES,
  type ScreenCaptureConnection,
} from "../src/extensions/live/screen-capture.js";
import { completeSimpleModel } from "../src/extensions/pi-ai-models.js";

vi.mock("../src/extensions/pi-ai-models.js", () => ({ completeSimpleModel: vi.fn() }));

const visionModel = {
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  provider: "openai-codex",
  api: "openai-codex-responses",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} satisfies Model<Api>;

const textModel = {
  ...visionModel,
  id: "text-model",
  provider: "test",
  api: "openai-responses",
  input: ["text"],
} satisfies Model<Api>;

const sessions: LiveScreenCaptureSession[] = [];
const servers: LivePairingServer[] = [];
const jpegPath = resolve(
  "vendor/plannotator-ui/packages/ui/node_modules/highlight.js/styles/pojoaque.jpg",
);
const jpeg = readFileSync(jpegPath);

function paddedJpeg(targetBytes: number): Buffer {
  const segments: Buffer[] = [jpeg.subarray(0, 2)];
  let remaining = targetBytes - jpeg.byteLength;
  while (remaining > 4) {
    const payloadBytes = Math.min(remaining - 4, 65_531);
    const segment = Buffer.alloc(payloadBytes + 4);
    segment[0] = 0xff;
    segment[1] = 0xfe;
    segment.writeUInt16BE(payloadBytes + 2, 2);
    segments.push(segment);
    remaining -= segment.byteLength;
  }
  segments.push(jpeg.subarray(2));
  return Buffer.concat(segments);
}

function captureResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mimeType: "image/jpeg",
    data: jpeg.toString("base64"),
    width: 140,
    height: 140,
    displayId: "42",
    timestamp: 1_754_000_000_000,
    byteSize: jpeg.byteLength,
    sha256: createHash("sha256").update(jpeg).digest("hex"),
    ...overrides,
  };
}

function renderText(component: unknown): string {
  if (!(component instanceof Text)) throw new Error("Expected Text renderer component");
  return component.render(200).join("\n");
}

const rendererTheme = {
  fg: (_token: string, text: string) => text,
  bg: (_token: string, text: string) => text,
  bold: (text: string) => text,
  dim: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  inverse: (text: string) => text,
  strikethrough: (text: string) => text,
};

function connection(
  result: unknown = captureResult(),
  options: {
    open?: boolean;
    screenCapture?: boolean;
    request?: ScreenCaptureConnection["request"];
  } = {},
): ScreenCaptureConnection {
  return {
    open: options.open ?? true,
    supportsScreenCapture: options.screenCapture ?? true,
    request: options.request ?? vi.fn(async () => result),
  };
}

function createSession(sessionId = "session-1"): LiveScreenCaptureSession {
  // Generous budget: the e2e test does a real WS roundtrip with a 2MB+ JSON frame,
  // which can exceed tight timeouts on loaded CI runners.
  const session = new LiveScreenCaptureSession(sessionId, { requestTimeoutMs: 5_000 });
  sessions.push(session);
  return session;
}

function createContext(model: Model<Api>): ExtensionContext {
  return {
    model,
    modelRegistry: {
      getAvailable: () => [visionModel],
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
    },
  } as unknown as ExtensionContext;
}

afterEach(async () => {
  await Promise.all(sessions.splice(0).map(async (session) => session.close()));
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("look_at", () => {
  it("owns self-rendered call and result UI", () => {
    const tool = createLookAtToolDefinition(() => undefined);

    expect(tool.renderShell).toBe("self");
    expect(tool.renderCall).toBeTypeOf("function");
    expect(tool.renderResult).toBeTypeOf("function");
  });

  it("renders partial, collapsed, expanded, and helper-described states without screen content", () => {
    const tool = createLookAtToolDefinition(() => undefined);
    const state: Record<string, unknown> = {};
    const call = tool.renderCall?.(
      {},
      rendererTheme as never,
      {
        state,
        lastComponent: undefined,
        isPartial: true,
        isError: false,
        expanded: false,
      } as never,
    );
    expect(renderText(call)).toContain("capturing display");

    const details = {
      path: "/tmp/pi-live/capture.jpg",
      mimeType: "image/jpeg" as const,
      width: 2_560,
      height: 1_440,
      displayId: "42",
      timestamp: Date.parse("2026-04-12T10:00:00.000Z"),
      byteSize: 234_567,
      sha256: "a".repeat(64),
      pointerX: 1_280,
      pointerY: 720,
      describedBy: "openai-codex/gpt-5.6-luna",
    };
    const result = {
      content: [{ type: "text" as const, text: "SECRET SCREEN DESCRIPTION BASE64_PAYLOAD" }],
      details,
    };
    const collapsed = tool.renderResult?.(
      result,
      { expanded: false, isPartial: false },
      rendererTheme as never,
      {
        args: {},
        state,
        lastComponent: undefined,
        isPartial: false,
        isError: false,
      } as never,
    );
    const collapsedCallText = renderText(call);
    expect(collapsedCallText).toContain("viewed display 42");
    expect(collapsedCallText).toContain("2560×1440");
    expect(collapsedCallText).toContain("described by openai-codex/gpt-5.6-luna");
    expect(collapsedCallText).toMatch(/took \d+s/u);
    expect(renderText(collapsed)).toBe("");

    const expanded = tool.renderResult?.(
      result,
      { expanded: true, isPartial: false },
      rendererTheme as never,
      {
        args: {},
        state,
        lastComponent: undefined,
        isPartial: false,
        isError: false,
      } as never,
    );
    const expandedText = renderText(expanded);
    expect(expandedText).toContain("path: /tmp/pi-live/capture.jpg");
    expect(expandedText).toContain("mimeType: image/jpeg");
    expect(expandedText).toContain("dimensions: 2560×1440");
    expect(expandedText).toContain("pointer: 1280, 720");
    expect(expandedText).toContain("sha256: aaaaaaaaaaaa…");
    expect(expandedText).not.toContain("SECRET SCREEN DESCRIPTION");
    expect(expandedText).not.toContain("BASE64_PAYLOAD");
  });

  it.each([
    "Pi Live screen capture is unavailable: no active paired Pi Live app",
    "Pi Live app disconnected",
    "Paired Pi Live app does not support screenCapture; update the app to capture the display",
    "Screen Recording access is required to capture the display.",
    "Pi Live screen capture is already in progress",
    "Pi Live app request timed out: screen.capture",
    "Cancelled",
    "view_image could not describe the image: no authenticated vision model is available",
  ])("renders concise capture error: %s", (message) => {
    const tool = createLookAtToolDefinition(() => undefined);
    const state: Record<string, unknown> = {};
    const call = tool.renderCall?.(
      {},
      rendererTheme as never,
      {
        state,
        lastComponent: undefined,
        isPartial: false,
        isError: true,
        expanded: false,
      } as never,
    );
    const result = tool.renderResult?.(
      { content: [{ type: "text", text: message }] },
      { expanded: false, isPartial: false },
      rendererTheme as never,
      {
        args: {},
        state,
        lastComponent: undefined,
        isPartial: false,
        isError: true,
      } as never,
    );

    expect(renderText(call)).toContain("look at display failed");
    expect(renderText(result)).toContain(message);
  });
  it("reports unavailable when no live app is paired", async () => {
    const tool = createLookAtToolDefinition(() => undefined);
    await expect(
      tool.execute("look-1", {}, undefined, undefined, {} as ExtensionContext),
    ).rejects.toThrow("no active paired Pi Live app");
  });

  it("reports missing screen-capture capability for older clients", async () => {
    const session = createSession();
    session.attach(connection(captureResult(), { screenCapture: false }));
    const tool = createLookAtToolDefinition(() => session);

    await expect(
      tool.execute("look-2", {}, undefined, undefined, {} as ExtensionContext),
    ).rejects.toThrow("does not support screenCapture");
  });

  it("reports unavailable while the paired app is disconnected or reconnecting", async () => {
    const session = createSession();
    session.attach(connection(captureResult(), { open: false }));
    const tool = createLookAtToolDefinition(() => session);

    await expect(
      tool.execute("look-disconnected", {}, undefined, undefined, createContext(visionModel)),
    ).rejects.toThrow("no active paired Pi Live app");
  });

  it("surfaces Screen Recording permission denial without invoking vision analysis", async () => {
    const session = createSession();
    session.attach(
      connection(undefined, {
        request: vi.fn(async () =>
          Promise.reject(new Error("Screen Recording access is required to capture the display.")),
        ),
      }),
    );
    const tool = createLookAtToolDefinition(() => session);

    await expect(
      tool.execute("look-permission", {}, undefined, undefined, createContext(textModel)),
    ).rejects.toThrow("Screen Recording access is required to capture the display.");
    expect(completeSimpleModel).not.toHaveBeenCalled();
  });

  it("captures once, saves securely, and returns actual image content", async () => {
    const request = vi.fn(async () => captureResult({ displayId: "../../client-path" }));
    const session = createSession("session-secure");
    session.attach(connection(captureResult(), { request }));
    const tool = createLookAtToolDefinition(() => session);
    const updates: unknown[] = [];

    const result = await tool.execute(
      "look-3",
      {},
      undefined,
      (update) => updates.push(update),
      createContext(visionModel),
    );

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("screen.capture", {}, 5_000, undefined);
    const image = result.content.find((item): item is ImageContent => item.type === "image");
    expect(image).toEqual({ type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" });
    expect(result.details).toMatchObject({
      width: 140,
      height: 140,
      displayId: "../../client-path",
      byteSize: jpeg.byteLength,
    });
    expect(result.details.path).toMatch(/pi-live-session-secure-[^/]+\/[0-9a-f-]+\.jpg$/u);
    expect(result.details.path).not.toContain("client-path");
    expect(existsSync(result.details.path)).toBe(true);
    expect(readFileSync(result.details.path)).toEqual(jpeg);
    expect(completeSimpleModel).not.toHaveBeenCalled();
    expect(updates).toEqual([expect.objectContaining({ details: { phase: "capturing" } })]);

    await session.close();
    expect(existsSync(result.details.path)).toBe(false);
  });

  it("accepts valid pointer metadata within captured image bounds", async () => {
    const session = createSession("pointer-valid");
    session.attach(connection(captureResult({ pointerX: 139, pointerY: 0 })));

    await expect(session.capture()).resolves.toMatchObject({ pointerX: 139, pointerY: 0 });
  });

  it.each([
    [{ pointerX: 140, pointerY: 0 }, "pointer coordinates"],
    [{ pointerX: 0, pointerY: 140 }, "pointer coordinates"],
    [{ pointerX: -1, pointerY: 0 }, "invalid screen.capture metadata"],
    [{ pointerX: 1 }, "pointer metadata"],
    [{ pointerY: 1 }, "pointer metadata"],
  ])("rejects invalid optional pointer metadata %#", async (overrides, expected) => {
    const session = createSession("pointer-invalid");
    session.attach(connection(captureResult(overrides)));

    await expect(session.capture()).rejects.toThrow(expected);
  });

  it("returns a vision-helper description to text-only models", async () => {
    vi.mocked(completeSimpleModel).mockResolvedValue({
      role: "assistant",
      content: [{ type: "text", text: "A dark textured square fills the current display." }],
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    } as AssistantMessage);
    const session = createSession("session-text-only");
    session.attach(connection());
    const tool = createLookAtToolDefinition(() => session);
    const updates: unknown[] = [];

    const result = await tool.execute(
      "look-text",
      {},
      undefined,
      (update) => updates.push(update),
      createContext(textModel),
    );

    expect(result.content).toEqual([
      { type: "text", text: "A dark textured square fills the current display." },
    ]);
    expect(result.details).toMatchObject({
      path: expect.stringMatching(/\.jpg$/u),
      width: 140,
      height: 140,
      describedBy: "openai-codex/gpt-5.6-luna",
    });
    expect(completeSimpleModel).toHaveBeenCalledWith(
      visionModel,
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({ type: "image", mimeType: "image/jpeg" }),
            ]),
          }),
        ],
      }),
      expect.objectContaining({ apiKey: "test-key" }),
    );
    expect(updates).toEqual([
      expect.objectContaining({ details: { phase: "capturing" } }),
      expect.objectContaining({ details: { phase: "describing" } }),
    ]);
  });

  it("runs end to end over authenticated pairing RPC", async () => {
    const highResolutionJpeg = paddedJpeg(2 * 1024 * 1024);
    const server = new LivePairingServer({
      sessionId: "session-e2e",
      mode: "local",
      heartbeatMs: 60_000,
    });
    servers.push(server);
    const descriptor = await server.start();
    const { payload, secret } = decodePairingUri(descriptor.uri);
    const endpoint = payload.endpoints.find((candidate) => candidate.type === "local");
    if (endpoint?.type !== "local") throw new Error("Missing local endpoint");
    const accepted = server.accept();
    const socket = new WebSocket(endpoint.url);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      socket.once("open", resolveOpen);
      socket.once("error", rejectOpen);
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
            screenCapture: true,
          },
        },
      }),
    );
    await new Promise<void>((resolvePair) => socket.once("message", () => resolvePair()));
    const captureSession = createSession("session-e2e");
    captureSession.attach(await accepted);
    const tool = createLookAtToolDefinition(() => captureSession);
    const requestReceived = new Promise<void>((resolveRequest, rejectRequest) => {
      socket.once("message", (frame) => {
        try {
          const request = JSON.parse(frame.toString()) as {
            id: string;
            method: string;
            params: Record<string, never>;
          };
          expect(request).toMatchObject({ method: "screen.capture", params: {} });
          socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result: captureResult({
                data: highResolutionJpeg.toString("base64"),
                byteSize: highResolutionJpeg.byteLength,
                sha256: createHash("sha256").update(highResolutionJpeg).digest("hex"),
              }),
            }),
          );
          resolveRequest();
        } catch (error) {
          rejectRequest(error);
        }
      });
    });

    const result = await tool.execute(
      "look-e2e",
      {},
      undefined,
      undefined,
      createContext(visionModel),
    );
    await requestReceived;

    expect(result.content).toContainEqual(
      expect.objectContaining({ type: "image", mimeType: "image/jpeg" }),
    );
    expect(existsSync(result.details.path)).toBe(true);
    expect(result.details.byteSize).toBe(highResolutionJpeg.byteLength);
    expect(readFileSync(result.details.path)).toEqual(highResolutionJpeg);
    socket.close(1000, "done");
  }, 15_000);

  it.each([
    ["malformed Base64", { data: "not base64%%" }, "invalid Base64"],
    ["wrong MIME", { mimeType: "image/png" }, "image/jpeg"],
    ["wrong JPEG magic", { data: Buffer.from("not-jpeg").toString("base64"), byteSize: 8 }, "JPEG"],
    ["wrong declared size", { byteSize: jpeg.byteLength + 1 }, "byteSize"],
    ["wrong dimensions", { width: 141 }, "dimensions"],
    ["wrong checksum", { sha256: "0".repeat(64) }, "sha256"],
  ])("rejects %s without leaking image data", async (_name, overrides, expected) => {
    const payload = captureResult(overrides);
    const session = createSession();
    session.attach(connection(payload));

    const failure = await session.capture().catch((error: unknown) => error as Error);
    expect(failure.message).toContain(expected);
    expect(failure.message).not.toContain(String(payload.data));
  });

  it("rejects decoded capture data over 6 MiB", async () => {
    const oversized = paddedJpeg(MAX_CAPTURE_IMAGE_BYTES + 1);
    const session = createSession();
    session.attach(
      connection(
        captureResult({
          data: oversized.toString("base64"),
          byteSize: oversized.byteLength,
          sha256: createHash("sha256").update(oversized).digest("hex"),
        }),
      ),
    );

    await expect(session.capture()).rejects.toThrow("decoded image is oversized");
  });

  it("rejects encoded screen.capture responses over 8 MiB", async () => {
    const server = new LivePairingServer({ sessionId: "encoded-frame", mode: "local" });
    servers.push(server);
    const descriptor = await server.start();
    const { payload, secret } = decodePairingUri(descriptor.uri);
    const endpoint = payload.endpoints.find((candidate) => candidate.type === "local");
    if (endpoint?.type !== "local") throw new Error("Missing local endpoint");
    const accepted = server.accept();
    const socket = new WebSocket(endpoint.url);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      socket.once("open", resolveOpen);
      socket.once("error", rejectOpen);
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
            screenCapture: true,
          },
        },
      }),
    );
    await new Promise<void>((resolvePair) => socket.once("message", () => resolvePair()));
    const liveConnection = await accepted;
    const request = liveConnection.request("screen.capture", {});
    const responseSent = new Promise<void>((resolveResponse) => {
      socket.once("message", (frame) => {
        const parsed = JSON.parse(frame.toString()) as { id: string };
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            result: { data: "A".repeat(MAX_SCREEN_CAPTURE_FRAME_BYTES) },
          }),
        );
        resolveResponse();
      });
    });
    await responseSent;
    await expect(request).rejects.toThrow();
  });

  it("keeps ordinary non-capture RPC responses capped at 512 KiB", async () => {
    const server = new LivePairingServer({ sessionId: "ordinary-frame", mode: "local" });
    servers.push(server);
    const descriptor = await server.start();
    const { payload, secret } = decodePairingUri(descriptor.uri);
    const endpoint = payload.endpoints.find((candidate) => candidate.type === "local");
    if (endpoint?.type !== "local") throw new Error("Missing local endpoint");
    const accepted = server.accept();
    const socket = new WebSocket(endpoint.url);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      socket.once("open", resolveOpen);
      socket.once("error", rejectOpen);
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
        },
      }),
    );
    await new Promise<void>((resolvePair) => socket.once("message", () => resolvePair()));
    const liveConnection = await accepted;
    const request = liveConnection.request("threads.list", {});
    const responseSent = new Promise<void>((resolveResponse) => {
      socket.once("message", (frame) => {
        const parsed = JSON.parse(frame.toString()) as { id: string };
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            result: { value: "x".repeat(512 * 1024) },
          }),
        );
        resolveResponse();
      });
    });
    await responseSent;
    await expect(request).rejects.toThrow("disconnected");
  });

  it("rejects timeout, disconnect, cancellation, and stale-session responses", async () => {
    const timeoutSession = createSession("timeout");
    timeoutSession.attach(
      connection(undefined, {
        request: vi.fn(async () =>
          Promise.reject(new Error("Pi Live app request timed out: screen.capture")),
        ),
      }),
    );
    await expect(timeoutSession.capture()).rejects.toThrow("timed out");

    const disconnectedSession = createSession("disconnect");
    disconnectedSession.attach(
      connection(undefined, {
        request: vi.fn(async () => Promise.reject(new Error("Pi Live app disconnected"))),
      }),
    );
    await expect(disconnectedSession.capture()).rejects.toThrow("disconnected");

    const abortController = new AbortController();
    abortController.abort(new DOMException("Cancelled", "AbortError"));
    const cancelledSession = createSession("cancelled");
    cancelledSession.attach(connection());
    await expect(cancelledSession.capture(abortController.signal)).rejects.toMatchObject({
      name: "AbortError",
    });

    const deferred = Promise.withResolvers<unknown>();
    const staleSession = createSession("stale");
    staleSession.attach(connection(undefined, { request: vi.fn(async () => deferred.promise) }));
    const capture = staleSession.capture();
    staleSession.attach(connection());
    deferred.resolve(captureResult());
    await expect(capture).rejects.toThrow("stale live session");
  });

  it("allows only one capture at a time and isolates live sessions", async () => {
    const deferred = Promise.withResolvers<unknown>();
    const firstRequest = vi.fn(async () => deferred.promise);
    const first = createSession("first");
    const second = createSession("second");
    first.attach(connection(undefined, { request: firstRequest }));
    second.attach(connection());

    const activeCapture = first.capture();
    await expect(first.capture()).rejects.toThrow("already in progress");
    const secondCapture = await second.capture();
    expect(secondCapture.path).toContain("pi-live-second-");
    deferred.resolve(captureResult());
    await expect(activeCapture).resolves.toMatchObject({ displayId: "42" });
    expect(firstRequest).toHaveBeenCalledOnce();
  });
});
