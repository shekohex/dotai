import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Context } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import { calls, createTestSession, says, when } from "@support/pi-test-harness";
import { createPlaybookStreamFn } from "@support/pi-test-harness/playbook";

import searchToolsExtension, {
  canLoadDeferredTool,
  parseSearchToolsResultDetails,
} from "../src/extensions/search-tools.js";
import { syncModeTools } from "../src/extensions/modes/tools.js";
import { defaultModes } from "../src/default-modes.js";
import { groupedExtensionsC } from "../src/extensions/definitions-group-c.js";

process.env.OPENAI_API_KEY ??= "test-key";

class SearchToolsPi {
  readonly tools = new Map<string, ToolDefinition>();
  activeTools = ["read"];
  setActiveToolsCalls = 0;
  private readonly eventHandlers = new Map<string, Array<(payload: unknown) => void>>();

  registerTool(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  getAllTools(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  getActiveTools(): string[] {
    return [...this.activeTools];
  }

  setActiveTools(toolNames: string[]): void {
    this.setActiveToolsCalls += 1;
    this.activeTools = [...toolNames];
  }

  on(): void {}

  readonly events = {
    on: (eventName: string, handler: (payload: unknown) => void) => {
      this.eventHandlers.set(eventName, [...(this.eventHandlers.get(eventName) ?? []), handler]);
      return undefined;
    },
  };

  emitEvent(eventName: string, payload: unknown): void {
    for (const handler of this.eventHandlers.get(eventName) ?? []) handler(payload);
  }
}

function registerTool(pi: SearchToolsPi, name: string, description: string): void {
  pi.registerTool({
    name,
    label: name,
    description,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
  });
}

const RANKING_TOOL_FIXTURES = [
  ["ask_user_question", "Collect structured answers and preferences from the user"],
  ["execute", "Execute TypeScript in a sandboxed runtime and call integrations"],
  ["generate_image", "Generate raster images, illustrations, and pictures"],
  ["goal", "Manage durable autonomous objectives"],
  ["session_query", "Query prior Pi conversation records"],
  ["subagent", "Manage isolated child sessions and review workflow results"],
  ["workflow", "Run orchestration plans with parallel agents"],
] as const;

async function searchRankingFixtures(
  query: string,
  limit?: number,
): Promise<{ matches: string[]; added: string[] }> {
  const fakePi = new SearchToolsPi();
  for (const [name, description] of RANKING_TOOL_FIXTURES) {
    registerTool(fakePi, name, description);
  }
  searchToolsExtension(fakePi as unknown as ExtensionAPI);
  fakePi.activeTools.push("search_tools");
  const searchTool = fakePi.tools.get("search_tools");
  if (searchTool === undefined) throw new Error("search_tools was not registered");
  const result = await searchTool.execute(
    "search-ranking",
    limit === undefined ? { query } : { query, limit },
    undefined,
    undefined,
    {} as never,
  );
  return result.details as { matches: string[]; added: string[] };
}

describe("search_tools", () => {
  test("is bundled as the optional tool loader", () => {
    expect(groupedExtensionsC.some((definition) => definition.id === "search-tools")).toBe(true);
  });

  test("serializes loader calls so concurrent searches cannot lose additions", () => {
    const fakePi = new SearchToolsPi();
    searchToolsExtension(fakePi as unknown as ExtensionAPI);

    expect(fakePi.tools.get("search_tools")?.executionMode).toBe("sequential");
  });

  test("owns its compact expandable tool rendering", () => {
    const fakePi = new SearchToolsPi();
    searchToolsExtension(fakePi as unknown as ExtensionAPI);
    const searchTool = fakePi.tools.get("search_tools");

    expect(searchTool?.renderShell).toBe("self");
    expect(searchTool?.renderCall).toBeTypeOf("function");
    expect(searchTool?.renderResult).toBeTypeOf("function");
  });

  test("loads matching registered tools without replacing active tools", async () => {
    const fakePi = new SearchToolsPi();
    registerTool(fakePi, "subagent", "Delegate work to a child agent");
    registerTool(fakePi, "workflow", "Run multi-agent workflow orchestration");
    searchToolsExtension(fakePi as unknown as ExtensionAPI);
    fakePi.activeTools.push("search_tools");

    const searchTool = fakePi.tools.get("search_tools");
    if (searchTool === undefined) throw new Error("search_tools was not registered");

    const result = await searchTool.execute(
      "search-1",
      { query: "delegate to a child agent" },
      undefined,
      undefined,
      {} as never,
    );

    expect(fakePi.activeTools).toEqual(["read", "search_tools", "subagent"]);
    expect(result.details).toMatchObject({
      matches: ["subagent"],
      added: ["subagent"],
    });
  });

  test("ignores conversational filler when matching a capability", async () => {
    const fakePi = new SearchToolsPi();
    registerTool(fakePi, "generate_image", "Generate or edit raster images");
    searchToolsExtension(fakePi as unknown as ExtensionAPI);
    fakePi.activeTools.push("search_tools");
    const searchTool = fakePi.tools.get("search_tools");
    if (searchTool === undefined) throw new Error("search_tools was not registered");

    const result = await searchTool.execute(
      "search-natural",
      { query: "please create an image for me" },
      undefined,
      undefined,
      {} as never,
    );

    expect(result.details).toMatchObject({
      matches: ["generate_image"],
      added: ["generate_image"],
    });
  });

  test("does not load loosely related tools beside a stronger match", async () => {
    const fakePi = new SearchToolsPi();
    registerTool(fakePi, "session_query", "Query a previous Pi session for session history");
    registerTool(
      fakePi,
      "subagent",
      "Manage child Pi sessions, search broadly, and use session_query for focused lookups",
    );
    registerTool(fakePi, "execute", "Search configured API tools and run queries");
    searchToolsExtension(fakePi as unknown as ExtensionAPI);
    fakePi.activeTools.push("search_tools");
    const searchTool = fakePi.tools.get("search_tools");
    if (searchTool === undefined) throw new Error("search_tools was not registered");

    const result = await searchTool.execute(
      "search-precision",
      { query: "query search previous Pi coding agent sessions conversation history" },
      undefined,
      undefined,
      {} as never,
    );

    expect(result.details).toMatchObject({
      matches: ["session_query"],
      added: ["session_query"],
    });
  });

  test("matches a tool name with an adjacent transposition", async () => {
    const fakePi = new SearchToolsPi();
    registerTool(fakePi, "workflow", "Run orchestration plans");
    searchToolsExtension(fakePi as unknown as ExtensionAPI);
    fakePi.activeTools.push("search_tools");
    const searchTool = fakePi.tools.get("search_tools");
    if (searchTool === undefined) throw new Error("search_tools was not registered");

    const result = await searchTool.execute(
      "search-transposition",
      { query: "workflwo" },
      undefined,
      undefined,
      {} as never,
    );

    expect(result.details).toMatchObject({ matches: ["workflow"], added: ["workflow"] });
  });

  test("returns reusable score diagnostics for rendering and consumers", async () => {
    const fakePi = new SearchToolsPi();
    registerTool(fakePi, "workflow", "Run orchestration plans");
    searchToolsExtension(fakePi as unknown as ExtensionAPI);
    fakePi.activeTools.push("search_tools");
    const searchTool = fakePi.tools.get("search_tools");
    if (searchTool === undefined) throw new Error("search_tools was not registered");

    const result = await searchTool.execute(
      "search-diagnostics",
      { query: "workflwo" },
      undefined,
      undefined,
      {} as never,
    );
    const details = parseSearchToolsResultDetails(result.details);

    expect(details).toBeDefined();
    expect(details?.candidates[0]).toMatchObject({
      name: "workflow",
      kind: "fuzzy_name",
      matchedText: "workflow",
    });
    expect(details?.candidates[0]?.confidence).toBeCloseTo(0.897);
  });

  test("matches a misspelled capability alias", async () => {
    const fakePi = new SearchToolsPi();
    registerTool(fakePi, "subagent", "Run isolated child work");
    searchToolsExtension(fakePi as unknown as ExtensionAPI);
    fakePi.activeTools.push("search_tools");
    const searchTool = fakePi.tools.get("search_tools");
    if (searchTool === undefined) throw new Error("search_tools was not registered");

    const result = await searchTool.execute(
      "search-alias-typo",
      { query: "delegte this task" },
      undefined,
      undefined,
      {} as never,
    );

    expect(result.details).toMatchObject({ matches: ["subagent"], added: ["subagent"] });
  });

  test("returns no match when weak candidates are equally plausible", async () => {
    const fakePi = new SearchToolsPi();
    registerTool(fakePi, "subagent", "Run isolated child work");
    registerTool(fakePi, "workflow", "Run isolated orchestration plans");
    searchToolsExtension(fakePi as unknown as ExtensionAPI);
    fakePi.activeTools.push("search_tools");
    const searchTool = fakePi.tools.get("search_tools");
    if (searchTool === undefined) throw new Error("search_tools was not registered");

    const result = await searchTool.execute(
      "search-ambiguous",
      { query: "isolated" },
      undefined,
      undefined,
      {} as never,
    );

    expect(result.details).toMatchObject({ matches: [], added: [], decision: "ambiguous" });
  });

  test("does not load tools denied by current mode", async () => {
    const fakePi = new SearchToolsPi();
    registerTool(fakePi, "subagent", "Delegate work to a child agent");
    searchToolsExtension(fakePi as unknown as ExtensionAPI);
    fakePi.activeTools.push("search_tools");
    fakePi.emitEvent("modes:changed", {
      spec: { tools: ["*", "!subagent"] },
    });

    const searchTool = fakePi.tools.get("search_tools");
    if (searchTool === undefined) throw new Error("search_tools was not registered");
    const result = await searchTool.execute(
      "search-2",
      { query: "delegate to child agent" },
      undefined,
      undefined,
      {} as never,
    );

    expect(fakePi.activeTools).toEqual(["read", "search_tools"]);
    expect(result.details).toMatchObject({ matches: [], added: [] });
  });

  test("does not rewrite active tools when a matching tool is already loaded", async () => {
    const fakePi = new SearchToolsPi();
    registerTool(fakePi, "goal", "Manage a durable autonomous goal");
    searchToolsExtension(fakePi as unknown as ExtensionAPI);
    fakePi.activeTools.push("search_tools", "goal");
    const searchTool = fakePi.tools.get("search_tools");
    if (searchTool === undefined) throw new Error("search_tools was not registered");

    const result = await searchTool.execute(
      "search-3",
      { query: "durable goal" },
      undefined,
      undefined,
      {} as never,
    );

    expect(fakePi.setActiveToolsCalls).toBe(0);
    expect(result.details).toMatchObject({
      matches: ["goal"],
      added: [],
      alreadyActive: ["goal"],
    });
  });

  test("returns no matches without changing tools for unrelated queries", async () => {
    const fakePi = new SearchToolsPi();
    registerTool(fakePi, "workflow", "Run multi-agent workflow orchestration");
    searchToolsExtension(fakePi as unknown as ExtensionAPI);
    fakePi.activeTools.push("search_tools");
    const searchTool = fakePi.tools.get("search_tools");
    if (searchTool === undefined) throw new Error("search_tools was not registered");

    const result = await searchTool.execute(
      "search-4",
      { query: "database migration" },
      undefined,
      undefined,
      {} as never,
    );

    expect(fakePi.setActiveToolsCalls).toBe(0);
    expect(result.details).toMatchObject({ matches: [], added: [], decision: "no_match" });
  });

  test("never exposes nested subagents or user prompts inside child sessions", () => {
    expect(canLoadDeferredTool("subagent", ["*"], true, ["subagent"])).toBe(false);
    expect(canLoadDeferredTool("ask_user_question", ["*"], true, ["ask_user_question"])).toBe(
      false,
    );
    expect(canLoadDeferredTool("workflow", ["*"], true, ["workflow"])).toBe(true);
    expect(canLoadDeferredTool("workflow", ["*"], true, ["read", "search_tools"])).toBe(false);
  });

  test("ask mode uses search_tools while worker mode still denies nested subagents", () => {
    expect(defaultModes.modes.ask.tools).toContain("search_tools");
    expect(defaultModes.modes.ask.tools).not.toContain("execute");
    expect(defaultModes.modes.ask.tools).not.toContain("subagent");
    expect(canLoadDeferredTool("subagent", defaultModes.modes.worker.tools, false)).toBe(false);
  });

  test("wildcard modes keep deferred tools inactive until searched", () => {
    const fakePi = new SearchToolsPi();
    registerTool(fakePi, "read", "Read files");
    for (const toolName of [
      "ask_user_question",
      "execute",
      "generate_image",
      "goal",
      "session_query",
      "subagent",
      "workflow",
    ]) {
      registerTool(fakePi, toolName, toolName);
    }
    registerTool(fakePi, "search_tools", "Search optional tools");
    fakePi.activeTools = [...fakePi.tools.keys()];

    syncModeTools(
      fakePi as unknown as ExtensionAPI,
      {} as never,
      { tools: ["*"] },
      { preserveActiveDeferredTools: false },
    );

    expect(fakePi.activeTools).toEqual(["read", "search_tools"]);
  });

  test("wildcard modes preserve tools loaded earlier in the session", async () => {
    const fakePi = new SearchToolsPi();
    registerTool(fakePi, "read", "Read files");
    registerTool(fakePi, "subagent", "Delegate work to a child agent");
    searchToolsExtension(fakePi as unknown as ExtensionAPI);
    fakePi.activeTools.push("search_tools");
    const searchTool = fakePi.tools.get("search_tools");
    if (searchTool === undefined) throw new Error("search_tools was not registered");

    await searchTool.execute(
      "search-preserve",
      { query: "delegate to a child agent" },
      undefined,
      undefined,
      {} as never,
    );
    syncModeTools(fakePi as unknown as ExtensionAPI, {} as never, { tools: ["*"] });

    expect(fakePi.activeTools).toEqual(["read", "search_tools", "subagent"]);
  });

  test("does not resurrect a deferred tool removed by a restrictive mode", async () => {
    const fakePi = new SearchToolsPi();
    registerTool(fakePi, "read", "Read files");
    registerTool(fakePi, "subagent", "Delegate work to a child agent");
    searchToolsExtension(fakePi as unknown as ExtensionAPI);
    fakePi.activeTools.push("search_tools");
    const searchTool = fakePi.tools.get("search_tools");
    if (searchTool === undefined) throw new Error("search_tools was not registered");

    await searchTool.execute(
      "search-remove",
      { query: "delegate to a child agent" },
      undefined,
      undefined,
      {} as never,
    );
    syncModeTools(fakePi as unknown as ExtensionAPI, {} as never, { tools: ["read"] });
    syncModeTools(fakePi as unknown as ExtensionAPI, {} as never, { tools: ["*"] });

    expect(fakePi.activeTools).toEqual(["read", "search_tools"]);
  });

  test("explicit mode rules can opt a deferred tool into the initial set", () => {
    const fakePi = new SearchToolsPi();
    registerTool(fakePi, "goal", "Manage a durable goal");

    syncModeTools(fakePi as unknown as ExtensionAPI, {} as never, {
      tools: ["goal"],
    });

    expect(fakePi.activeTools).toEqual(["goal"]);
  });

  test("records loaded definitions on the search tool result", async () => {
    const testSession = await createTestSession({
      extensionFactories: [
        (pi) => {
          pi.registerTool({
            name: "subagent",
            label: "Subagent",
            description: "Delegate work to a child agent",
            parameters: Type.Object({}),
            execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
          });
        },
        searchToolsExtension,
      ],
    });

    try {
      const agent = testSession.session.agent as {
        state: { tools: unknown[]; messages: Array<Record<string, unknown>> };
        setTools?: (tools: unknown[]) => void;
      };
      agent.setTools ??= (tools) => {
        agent.state.tools = tools;
      };
      testSession.session.setActiveToolsByName(["search_tools"]);
      const turn = when("delegate this", [
        calls("search_tools", { query: "delegate to a child agent" }),
        says("loaded"),
      ]);
      const { streamFn } = createPlaybookStreamFn([turn]);
      const providerContexts: Context[] = [];
      (testSession.session.agent as any).streamFunction = (
        model: any,
        context: Context,
        options: any,
      ) => {
        providerContexts.push(context);
        return streamFn(model, context, options);
      };
      (testSession.session.agent as any).getApiKey = () => "test-key";

      await testSession.session.prompt(turn.prompt);
      await (testSession.session.agent as any).waitForIdle();

      const searchResult = providerContexts
        .at(-1)
        ?.messages.find(
          (message) => message.role === "toolResult" && message.toolName === "search_tools",
        );
      expect(searchResult?.addedToolNames).toEqual(["subagent"]);
      expect(testSession.session.getActiveToolNames()).toEqual(["search_tools", "subagent"]);
    } finally {
      testSession.dispose();
    }
  });

  test.each([
    ["matches exact names case-insensitively", "WORKFLOW", ["workflow"]],
    ["treats snake-case names as words", "session query", ["session_query"]],
    ["normalizes punctuation inside aliases", "ask-user", ["ask_user_question"]],
    ["canonicalizes plural capability words", "previous sessions", ["session_query"]],
    ["matches a tool name missing its final character", "workflo", ["workflow"]],
    ["matches an alias containing a substitution", "delegote", ["subagent"]],
    [
      "matches a multi-word alias containing transpositions",
      "conversatoin histroy",
      ["session_query"],
    ],
    ["prefers a longer exact alias", "parallel agent", ["subagent"]],
    ["prefers an exact name over another tool description", "workflow", ["workflow"]],
    ["uses an exact description phrase as fallback", "sandboxed runtime", ["execute"]],
    ["rejects weak partial description overlap", "sandboxed database", []],
    [
      "returns multiple explicitly named tools deterministically",
      "workflow subagent",
      ["subagent", "workflow"],
    ],
  ])("%s", async (_name, query, expectedMatches) => {
    const result = await searchRankingFixtures(query as string);

    expect(result.matches).toEqual(expectedMatches);
    expect(result.added).toEqual(expectedMatches);
  });

  test("applies the result limit after deterministic exact ranking", async () => {
    const result = await searchRankingFixtures("workflow subagent", 1);

    expect(result).toMatchObject({ matches: ["subagent"], added: ["subagent"] });
  });
});
