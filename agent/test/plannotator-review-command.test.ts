import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

describe("plannotator review command", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function createContext(notify: (message: string, level?: string) => void): ExtensionContext {
    return {
      cwd: process.cwd(),
      hasUI: true,
      ui: {
        setWidget() {},
        notify,
        onTerminalInput(handler: (data: string) => unknown) {
          return handler;
        },
      },
      sessionManager: {
        getEntries: () => [],
        getBranch: () => [],
        getSessionId: () => "session-1",
        getSessionFile: () => undefined,
        getSessionName: () => undefined,
      },
      shutdown() {},
    } as unknown as ExtensionContext;
  }

  it("reuses existing review server when configured port is already in use", async () => {
    const notify = vi.fn();
    const cwd = process.cwd();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ agentCwd: cwd }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as typeof fetch;

    vi.doMock("../src/extensions/plannotator/plannotator-command-deps.js", async () => {
      const actual = await vi.importActual<object>(
        "../src/extensions/plannotator/plannotator-command-deps.js",
      );
      return {
        ...actual,
        hasReviewBrowserHtml: () => true,
        parseReviewArgs: () => ({}),
        startCodeReviewBrowserSession: vi.fn(async () => {
          throw new Error(
            "Port 19432 in use after 5 retries (set PLANNOTATOR_PORT to use a different port)",
          );
        }),
      };
    });

    vi.doMock("../src/extensions/plannotator/server/network.js", () => ({
      getServerPort: () => ({ port: 19432, portSource: "remote-default" }),
    }));

    try {
      const module = await import("../src/extensions/plannotator/plannotator-command-handlers.js");
      const handler = module.createPlannotatorReviewHandler({
        pi: { appendEntry() {} } as never,
        currentPiSession: { update() {} },
      });

      await handler(undefined, createContext(notify));

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://127.0.0.1:19432/api/diff",
        expect.objectContaining({ method: "GET" }),
      );
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("Code review already running. Reusing existing browser session."),
        "info",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
