import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildPublishBody,
  createNotifyClient,
  normalizePublishPayload,
} from "../src/extensions/notify/client.js";
import type {
  NotifyPublishPayload,
  ResolvedNotifySettings,
} from "../src/extensions/notify/types.js";

const settings: ResolvedNotifySettings = {
  enabled: true,
  baseUrl: "https://ntfy.0iq.xyz",
  defaultTopic: "default-topic",
  allowAnonymous: true,
  publishTimeoutMs: 5_000,
  debugEvents: false,
  defaultTags: ["pi"],
  defaultPriority: "default",
  retryMaxAttempts: 2,
  retryBaseDelayMs: 1,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("notify client", () => {
  test("normalizes multi-topic and default tags", () => {
    const payload: NotifyPublishPayload = {
      topic: ["one", "two"],
      message: "hello",
      tags: ["custom"],
      meta: { sourceExtension: "test" },
    };
    const normalized = normalizePublishPayload(payload, settings);
    expect(normalized.topic).toEqual(["one", "two"]);
    expect(normalized.tags).toEqual(["pi", "custom"]);
    expect(normalized.priority).toBe("default");
  });

  test("builds ntfy JSON body", () => {
    const payload: NotifyPublishPayload = {
      topic: "topic",
      message: "body",
      actions: [{ action: "copy", label: "Copy", value: "123" }],
      meta: { sourceExtension: "test" },
    };
    const body = buildPublishBody(payload, "topic");
    expect(body).toMatchObject({ topic: "topic", message: "body" });
    expect(body.actions).toEqual([
      { action: "copy", label: "Copy", value: "123", clear: undefined },
    ]);
  });

  test("retries transient failures then succeeds", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const client = createNotifyClient(fetchMock);
    const result = await client.publishMany({
      payload: { topic: "topic", message: "body", meta: { sourceExtension: "test" } },
      auth: { configured: false, mode: "anonymous", headers: {}, label: "anonymous" },
      settings,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.successes).toHaveLength(1);
    expect(result.failures).toHaveLength(0);
  });

  test("returns failure after retry budget exhausted", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("down", { status: 503 }));
    const client = createNotifyClient(fetchMock);
    const result = await client.publishMany({
      payload: { topic: "topic", message: "body", meta: { sourceExtension: "test" } },
      auth: { configured: false, mode: "anonymous", headers: {}, label: "anonymous" },
      settings,
    });
    expect(result.successes).toHaveLength(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ retryable: false, attempts: 2 });
  });

  test("classifies auth failures without retry", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("forbidden", { status: 403 }));
    const client = createNotifyClient(fetchMock);
    const result = await client.publishMany({
      payload: { topic: "topic", message: "body", meta: { sourceExtension: "test" } },
      auth: {
        configured: true,
        mode: "bearer",
        headers: { Authorization: "Bearer x" },
        label: "bearer",
      },
      settings,
    });
    expect(result.failures[0]).toMatchObject({ classification: "auth", retryable: false });
  });

  test("handles network errors", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("socket hangup"));
    const client = createNotifyClient(fetchMock);
    const result = await client.publishMany({
      payload: { topic: ["one", "two"], message: "body", meta: { sourceExtension: "test" } },
      auth: { configured: false, mode: "anonymous", headers: {}, label: "anonymous" },
      settings,
    });
    expect(result.successes).toHaveLength(0);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]?.classification).toBe("network");
  });
});
