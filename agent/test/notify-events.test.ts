import { describe, expect, test } from "vitest";
import {
  parseNotifyActionInvokedEvent,
  parseNotifyActionResponseEvent,
  parseNotifyFailedEvent,
  parseNotifyPublishEvent,
  parseNotifyPublishedEvent,
  parseNotifyReceivedEvent,
} from "../src/extensions/notify/events.js";

describe("notify event parsing", () => {
  test("parses publish payload", () => {
    const parsed = parseNotifyPublishEvent({
      topic: ["a", "b"],
      message: "hello",
      meta: { sourceExtension: "test" },
    });
    expect(parsed?.message).toBe("hello");
  });

  test("parses publish payload with callback action", () => {
    const parsed = parseNotifyPublishEvent({
      topic: "a",
      message: "hello",
      actions: [
        {
          action: "callback",
          key: "retry-job",
          label: "Retry",
          payload: { jobId: "job-123" },
          method: "POST",
        },
      ],
      meta: { sourceExtension: "test" },
    });
    expect(parsed).not.toBeNull();
  });

  test("rejects invalid publish payload", () => {
    expect(parseNotifyPublishEvent({ topic: [], message: "hello" })).toBeNull();
  });

  test("rejects callback action missing key", () => {
    expect(
      parseNotifyPublishEvent({
        topic: "a",
        message: "hello",
        actions: [{ action: "callback", label: "Retry" }],
        meta: { sourceExtension: "test" },
      }),
    ).toBeNull();
  });

  test("rejects callback action with invalid method", () => {
    expect(
      parseNotifyPublishEvent({
        topic: "a",
        message: "hello",
        actions: [
          {
            action: "callback",
            key: "retry-job",
            label: "Retry",
            method: "TRACE",
          },
        ],
        meta: { sourceExtension: "test" },
      }),
    ).toBeNull();
  });

  test("parses action response", () => {
    const parsed = parseNotifyActionResponseEvent({ correlationId: "c1", statusCode: 204 });
    expect(parsed?.statusCode).toBe(204);
  });

  test("rejects invalid action response", () => {
    expect(parseNotifyActionResponseEvent({ statusCode: 204 })).toBeNull();
  });

  test("parses published event", () => {
    const parsed = parseNotifyPublishedEvent({
      topic: "alerts",
      request: { topic: "alerts", message: "hello", meta: { sourceExtension: "test" } },
      normalizedRequest: { topic: ["alerts"], message: "hello", meta: { sourceExtension: "test" } },
      response: { status: 200, body: "ok" },
      timestamp: Date.now(),
    });
    expect(parsed?.topic).toBe("alerts");
  });

  test("parses failed event", () => {
    const parsed = parseNotifyFailedEvent({
      request: { topic: "alerts", message: "hello", meta: { sourceExtension: "test" } },
      normalizedRequest: { topic: ["alerts"], message: "hello", meta: { sourceExtension: "test" } },
      error: "boom",
      classification: "http",
      retryable: false,
      attempts: 1,
      timestamp: Date.now(),
    });
    expect(parsed?.classification).toBe("http");
  });

  test("parses action invoked event", () => {
    const parsed = parseNotifyActionInvokedEvent({
      correlationId: "c1",
      actionId: "a1",
      sourceExtension: "notify-tool",
      callbackChannel: "notify:test",
      request: {
        method: "POST",
        path: "/notify/action",
        query: {},
        headers: {},
        body: "{}",
        timestamp: Date.now(),
      },
    });
    expect(parsed?.actionId).toBe("a1");
  });

  test("parses received event", () => {
    const parsed = parseNotifyReceivedEvent({
      receivedAt: Date.now(),
      topic: "alerts",
      message: { event: "message", topic: "alerts", message: "hi" },
    });
    expect(parsed?.message.event).toBe("message");
  });

  test("rejects malformed received event", () => {
    expect(parseNotifyReceivedEvent({ topic: "alerts", message: {} })).toBeNull();
  });
});
