import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import defaultFactory, {
  extractUserText,
  getRecentUserMessages,
} from "../src/extensions/session-name.js";

function mockEntry(
  type: string,
  role: string,
  content: string | { type: string; text?: string }[],
) {
  return {
    type,
    message: { role, content, timestamp: Date.now() },
    id: "id",
    parentId: null,
    timestamp: String(Date.now()),
  } as const;
}

function mockCtx(entries: ReturnType<typeof mockEntry>[]): ExtensionContext {
  return {
    sessionManager: {
      getEntries: () => entries as any,
    },
    modelRegistry: {} as any,
  } as unknown as ExtensionContext;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("extractUserText", () => {
  it("returns plain string content", () => {
    expect(extractUserText("hello world")).toBe("hello world");
  });

  it("extracts text from array content", () => {
    const content = [
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ];
    expect(extractUserText(content)).toBe("hello world");
  });

  it("skips non-text blocks", () => {
    const content = [
      { type: "text", text: "hello" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
      { type: "text", text: "world" },
    ];
    expect(extractUserText(content)).toBe("hello world");
  });

  it("returns undefined for empty result", () => {
    const content = [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
    ];
    expect(extractUserText(content)).toBeUndefined();
  });

  it("returns undefined for empty string content", () => {
    expect(extractUserText("   ")).toBeUndefined();
  });

  it("returns undefined for empty array", () => {
    expect(extractUserText([])).toBeUndefined();
  });
});

describe("getRecentUserMessages", () => {
  it("collects last 3 user entries plus current text", () => {
    const entries = [
      mockEntry("message", "user", "first"),
      mockEntry("message", "assistant", "response 1"),
      mockEntry("message", "user", "second"),
      mockEntry("message", "assistant", "response 2"),
      mockEntry("message", "user", "third"),
    ];
    const result = getRecentUserMessages(mockCtx(entries), "current");
    expect(result).toEqual(["first", "second", "third", "current"]);
  });

  it("skips non-message entries", () => {
    const entries = [
      mockEntry("compaction", "user", "should skip"),
      mockEntry("message", "user", "actual"),
    ];
    const result = getRecentUserMessages(mockCtx(entries), "current");
    expect(result).toEqual(["actual", "current"]);
  });

  it("skips assistant messages", () => {
    const entries = [
      mockEntry("message", "assistant", "should skip"),
      mockEntry("message", "user", "actual"),
    ];
    const result = getRecentUserMessages(mockCtx(entries), "current");
    expect(result).toEqual(["actual", "current"]);
  });

  it("includes only available messages when history is shorter than limit", () => {
    const entries = [mockEntry("message", "user", "only")];
    const result = getRecentUserMessages(mockCtx(entries), "current");
    expect(result).toEqual(["only", "current"]);
  });

  it("collects last 3 user entries from history when more exist", () => {
    const entries = [
      mockEntry("message", "user", "oldest"),
      mockEntry("message", "user", "older"),
      mockEntry("message", "user", "old"),
      mockEntry("message", "user", "recent"),
    ];
    const result = getRecentUserMessages(mockCtx(entries), "current");
    expect(result).toEqual(["older", "old", "recent", "current"]);
  });

  it("extracts text from array content in entries", () => {
    const entries = [
      mockEntry("message", "user", [
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ]),
    ];
    const result = getRecentUserMessages(mockCtx(entries), "current");
    expect(result).toEqual(["hello world", "current"]);
  });
});

describe("extension factory", () => {
  it("registers input and session_start handlers", () => {
    const handlers = new Map<string, Function>();
    const pi = {
      on: vi.fn((event: string, handler: Function) => {
        handlers.set(event, handler);
      }),
      getSessionName: vi.fn(() => "test"),
      setSessionName: vi.fn(),
    } as unknown as ExtensionAPI;

    defaultFactory(pi);

    expect(pi.on).toHaveBeenCalledWith("input", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(handlers.has("input")).toBe(true);
    expect(handlers.has("session_start")).toBe(true);
  });

  it("skips input starting with /", () => {
    const ctx = mockCtx([]);
    const names: string[] = [];
    const pi = {
      on: vi.fn((_event: string, handler: Function) => {
        if (_event === "input") {
          handler({ text: "/cmd", trim: () => "/cmd" }, ctx);
        }
      }),
      getSessionName: vi.fn(() => undefined),
      setSessionName: vi.fn((n: string) => names.push(n)),
    } as unknown as ExtensionAPI;

    defaultFactory(pi);
    expect(pi.setSessionName).not.toHaveBeenCalled();
  });

  it("skips short input (< 10 chars)", () => {
    const ctx = mockCtx([]);
    const pi = {
      on: vi.fn((_event: string, handler: Function) => {
        if (_event === "input") {
          handler({ text: "hi", trim: () => "hi" }, ctx);
        }
      }),
      getSessionName: vi.fn(() => undefined),
      setSessionName: vi.fn(),
    } as unknown as ExtensionAPI;

    defaultFactory(pi);
    expect(pi.setSessionName).not.toHaveBeenCalled();
  });

  it("resets counter on session_start", () => {
    const inputHandler = vi.fn();
    const sessionStartHandler = vi.fn();
    const pi = {
      on: vi.fn((event: string, handler: Function) => {
        if (event === "input") inputHandler.mockImplementation(handler);
        if (event === "session_start") sessionStartHandler.mockImplementation(handler);
      }),
      getSessionName: vi.fn(() => undefined),
      setSessionName: vi.fn(),
    } as unknown as ExtensionAPI;

    defaultFactory(pi);

    const ctx = {
      ...mockCtx([]),
      modelRegistry: {
        find: vi.fn(() => undefined),
      },
    };

    inputHandler(
      {
        text: "make a login page with validation",
        trim: () => "make a login page with validation",
      },
      ctx,
    );

    sessionStartHandler({ reason: "new" });

    inputHandler(
      { text: "add rate limiting to the api", trim: () => "add rate limiting to the api" },
      ctx,
    );

    expect(pi.setSessionName).not.toHaveBeenCalled();
  });
});
