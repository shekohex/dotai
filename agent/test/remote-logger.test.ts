import { afterEach, expect, test, vi } from "vitest";
import { createRemoteApp } from "../src/remote/app.ts";
import { createInProcessFetch } from "../src/remote/client-runtime.ts";
import { configureLogger, logSseFrame } from "../src/remote/http-adapters.ts";
import { RemoteApiClient } from "../src/remote/runtime-api/client.ts";
import type { SessionSyncEvent } from "../src/remote/schemas.ts";
import { TEST_ED25519_KEYS } from "./remote-test-keys.ts";

afterEach(() => {
  vi.restoreAllMocks();
  configureLogger({ enabled: true, color: false, pretty: true, logSse: true });
});

test("logSseFrame logs summarized SSE payload shape", () => {
  const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  configureLogger({ enabled: true, color: false, pretty: true, logSse: true });

  logSseFrame("data", {
    type: "patch",
    sessionId: "session-1",
    version: "3",
    patch: {
      patchType: "tool.execution",
      payload: {
        toolCallId: "tool-1",
        delta: { text: "hello" },
      },
    },
  } satisfies SessionSyncEvent);

  expect(consoleSpy).toHaveBeenCalledTimes(1);
  expect(consoleSpy.mock.calls[0]?.[0]).toContain('"frameType": "data"');
  expect(consoleSpy.mock.calls[0]?.[0]).toContain('"eventType": "patch"');
  expect(consoleSpy.mock.calls[0]?.[0]).toContain('"patchType": "tool.execution"');
  expect(consoleSpy.mock.calls[0]?.[0]).toContain('"payloadShape"');
  expect(consoleSpy.mock.calls[0]?.[0]).not.toContain('"hello"');
});

test("session sync endpoint emits SSE shape logs for sent updates", async () => {
  const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const remote = createRemoteApp({
    origin: "http://localhost:3000",
    allowedKeys: [{ keyId: "dev", publicKey: TEST_ED25519_KEYS.publicKeyPem }],
    loggerOptions: { enabled: true, color: false, pretty: true, logSse: true },
  });

  try {
    const client = new RemoteApiClient({
      origin: "http://localhost:3000",
      auth: {
        keyId: "dev",
        privateKey: TEST_ED25519_KEYS.privateKeyPem,
      },
      fetchImpl: createInProcessFetch(remote.app),
    });
    await client.authenticate();
    const created = await client.createSession({ persistence: "persistent" });

    const events: SessionSyncEvent[] = [];
    const controller = new AbortController();
    try {
      await client.readSessionSync(created.sessionId, {
        signal: controller.signal,
        onSyncEvent: (event) => {
          events.push(event);
          if (event.type === "snapshot") {
            controller.abort();
          }
        },
      });
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "AbortError") {
        throw error;
      }
    }

    expect(events.map((event) => event.type)).toEqual(["server.connected", "snapshot"]);

    const sseLogs = consoleSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((entry) => entry.includes('"frameType": "data"'));
    expect(sseLogs.length).toBeGreaterThanOrEqual(2);
    expect(sseLogs.some((entry) => entry.includes('"eventType": "server.connected"'))).toBe(true);
    expect(sseLogs.some((entry) => entry.includes('"eventType": "snapshot"'))).toBe(true);
  } finally {
    await remote.dispose();
  }
}, 15_000);
