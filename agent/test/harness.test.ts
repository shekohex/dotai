import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calls, createTestSession, says, when, type TestSession } from "@marcfargas/pi-test-harness";
import { initTheme } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import webFetchExtension from "../src/extensions/fetch.ts";
import patchExtension from "../src/extensions/patch.ts";
import { installBundledResourcePaths } from "../src/extensions/bundled-resources.ts";
import {
  setRegisteredThemes,
  theme as activeTheme,
} from "../node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.js";

process.env.OPENAI_API_KEY ??= "test-key";

function forceApplyPatchExtension(pi: ExtensionAPI) {
  const enablePatchTool = () => {
    const nextTools = new Set(pi.getActiveTools().filter((toolName) => toolName !== "edit" && toolName !== "write"));
    nextTools.add("apply_patch");
    pi.setActiveTools(Array.from(nextTools));
  };

  pi.on("session_start", async () => {
    enablePatchTool();
  });

  pi.on("before_agent_start", async () => {
    enablePatchTool();
    return undefined;
  });
}

function patchHarnessAgent(testSession: TestSession): void {
  const agent = testSession.session.agent as { state: { tools: unknown[] }; setTools?: (tools: unknown[]) => void };
  agent.setTools ??= (tools: unknown[]) => {
    agent.state.tools = tools;
  };
}

test("pi-test-harness runs apply_patch against the real tool implementation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-harness-"));
  const filePath = join(cwd, "sample.ts");
  let session: TestSession | undefined;

  await writeFile(filePath, "export const value = 1;\n", "utf8");

  try {
    session = await createTestSession({
      cwd,
      extensionFactories: [patchExtension, forceApplyPatchExtension],
    });
    patchHarnessAgent(session);

    await session.run(
      when("Patch sample.ts", [
        calls("apply_patch", {
          patchText: [
            "*** Begin Patch",
            "*** Update File: sample.ts",
            "@@",
            "-export const value = 1;",
            "+export const value = 2;",
            "*** End Patch",
          ].join("\n"),
        }),
        says("Patched."),
      ]),
    );

    assert.equal(await readFile(filePath, "utf8"), "export const value = 2;\n");
    assert.equal(session.events.toolCallsFor("apply_patch").length, 1);
    const toolExecutionEnd = session.events.all.find(
      (event) => event.type === "tool_execution_end" && event.toolName === "apply_patch",
    );
    assert.ok(toolExecutionEnd);
    assert.equal(toolExecutionEnd.isError, false);
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("pi-test-harness captures mocked built-in tool events", async () => {
  let session: TestSession | undefined;

  try {
    session = await createTestSession({
      mockTools: {
        bash: ({ command }) => `ran: ${command}`,
      },
    });
    patchHarnessAgent(session);

    await session.run(
      when("Run the preview tests", [
        calls("bash", { command: "npm run test:tool-preview" }),
        says("Done."),
      ]),
    );

    assert.deepEqual(session.events.toolSequence(), ["bash"]);
    assert.equal(session.events.toolResultsFor("bash")[0]?.mocked, true);
    assert.match(session.events.toolResultsFor("bash")[0]?.text ?? "", /ran: npm run test:tool-preview/);
  } finally {
    session?.dispose();
  }
});

test("pi-test-harness runs webfetch against the real tool implementation", async () => {
  let session: TestSession | undefined;
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v2/scrape") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "not found" }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }

    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      url?: string;
      formats?: string[];
    };

    assert.equal(req.headers.authorization, "Bearer fc-free");
    assert.equal(body.url, "https://example.com/harness");
    assert.deepEqual(body.formats, ["markdown"]);

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      data: {
        markdown: "# Fetch harness",
        html: "<html><body><h1>Fetch harness</h1></body></html>",
        metadata: {
          url: "https://example.com/harness",
          sourceURL: "https://example.com/harness",
          statusCode: 200,
          contentType: "text/html; charset=utf-8",
        },
      },
    }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const originalApiUrl = process.env.WEBFETCH_FIRECRAWL_API_URL;
  const originalFirecrawlApiKey = process.env.FIRECRAWL_API_KEY;
  process.env.WEBFETCH_FIRECRAWL_API_URL = `http://127.0.0.1:${address.port}`;
  delete process.env.FIRECRAWL_API_KEY;

  try {
    session = await createTestSession({
      extensionFactories: [webFetchExtension],
    });
    patchHarnessAgent(session);

    await session.run(
      when("Fetch a known URL", [
        calls("webfetch", { url: "https://example.com/harness", timeout: 10, format: "markdown" }),
        says("Fetched."),
      ]),
    );

    const toolExecutionEnd = session.events.all.find(
      (event) => event.type === "tool_execution_end" && event.toolName === "webfetch",
    );
    assert.ok(toolExecutionEnd);
    assert.equal(toolExecutionEnd.isError, false);

    const toolResult = session.events.toolResultsFor("webfetch")[0]?.text ?? "";
    assert.match(toolResult, /URL: https:\/\/example\.com\/harness/);
    assert.match(toolResult, /Status: 200 OK/);
    assert.match(toolResult, /# Fetch harness/);
  } finally {
    if (originalApiUrl === undefined) {
      delete process.env.WEBFETCH_FIRECRAWL_API_URL;
    } else {
      process.env.WEBFETCH_FIRECRAWL_API_URL = originalApiUrl;
    }
    if (originalFirecrawlApiKey === undefined) {
      delete process.env.FIRECRAWL_API_KEY;
    } else {
      process.env.FIRECRAWL_API_KEY = originalFirecrawlApiKey;
    }
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    session?.dispose();
  }
});

test("bundled themes are available before reload", async () => {
  installBundledResourcePaths();

  let session: TestSession | undefined;

  try {
    session = await createTestSession();

    const bundledThemes = session.session.resourceLoader.getThemes().themes;
    assert.ok(bundledThemes.some((loadedTheme) => loadedTheme.name === "catppuccin-mocha"));

    setRegisteredThemes(bundledThemes);
    initTheme("catppuccin-mocha");

    assert.equal(activeTheme.name, "catppuccin-mocha");
  } finally {
    session?.dispose();
  }
});
