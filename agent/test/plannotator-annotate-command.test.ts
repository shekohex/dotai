import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { parseAnnotateArgs } from "../src/extensions/plannotator/generated/annotate-args.ts";

describe("plannotator annotate command", () => {
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

  it("strips render-html flag from annotate path parsing", () => {
    expect(parseAnnotateArgs("docs/demo.html --render-html --gate")).toMatchObject({
      filePath: "docs/demo.html",
      rawFilePath: "docs/demo.html",
      gate: true,
      renderHtml: true,
    });
  });

  it("reuses existing annotate server when same annotation session is already running", async () => {
    const notify = vi.fn();
    const cwd = process.cwd();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            projectRoot: cwd,
            filePath: "/tmp/demo.html",
            mode: "annotate",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    ) as typeof fetch;

    vi.doMock("../src/extensions/plannotator/plannotator-command-deps.js", async () => {
      const actual = await vi.importActual<object>(
        "../src/extensions/plannotator/plannotator-command-deps.js",
      );
      return {
        ...actual,
        hasPlanBrowserHtml: () => true,
        parseAnnotateArgs: () => ({
          filePath: "/tmp/demo.html",
          rawFilePath: "/tmp/demo.html",
          gate: false,
          json: false,
          hook: false,
          renderHtml: true,
        }),
        resolveAtReference: (candidate: string) => candidate,
        startMarkdownAnnotationSession: vi.fn(),
      };
    });

    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        existsSync: () => true,
        statSync: () => ({ isDirectory: () => false, size: 128 }),
        readFileSync: () => "<html></html>",
      };
    });

    vi.doMock("../src/extensions/plannotator/server/network.js", () => ({
      getServerPort: () => ({ port: 19432, portSource: "remote-default" }),
    }));

    try {
      const module = await import("../src/extensions/plannotator/plannotator-command-handlers.js");
      const handler = module.createPlannotatorAnnotateHandler({
        pi: { appendEntry() {} } as never,
        currentPiSession: { update() {} },
      });

      await handler("/tmp/demo.html --render-html", createContext(notify));

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://127.0.0.1:19432/api/plan",
        expect.objectContaining({ method: "GET" }),
      );
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("Annotation already running. Reusing existing browser session."),
        "info",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reuses existing last-message annotation session on matching server", async () => {
    const notify = vi.fn();
    const cwd = process.cwd();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            projectRoot: cwd,
            filePath: "last-message",
            mode: "annotate-last",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    ) as typeof fetch;

    vi.doMock("../src/extensions/plannotator/plannotator-command-deps.js", async () => {
      const actual = await vi.importActual<object>(
        "../src/extensions/plannotator/plannotator-command-deps.js",
      );
      return {
        ...actual,
        hasPlanBrowserHtml: () => true,
        parseAnnotateArgs: () => ({
          filePath: "",
          rawFilePath: "",
          gate: false,
          json: false,
          hook: false,
          renderHtml: false,
        }),
        getLastAssistantMessageSnapshot: () => ({ text: "hello" }),
        startLastMessageAnnotationSession: vi.fn(),
      };
    });

    vi.doMock("../src/extensions/plannotator/server/network.js", () => ({
      getServerPort: () => ({ port: 19432, portSource: "remote-default" }),
    }));

    try {
      const module = await import("../src/extensions/plannotator/plannotator-command-handlers.js");
      const handler = module.createPlannotatorLastHandler({
        pi: { appendEntry() {} } as never,
        currentPiSession: { update() {} },
      });

      await handler(undefined, createContext(notify));

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://127.0.0.1:19432/api/plan",
        expect.objectContaining({ method: "GET" }),
      );
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining(
          "Last-message annotation already running. Reusing existing browser session.",
        ),
        "info",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
