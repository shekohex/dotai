import { rmSync } from "node:fs";

import { afterEach, expect, test, vi } from "vitest";
import { calls, createTestSession, says, when, type TestSession } from "@support/pi-test-harness";
import { createPlaybookStreamFn } from "@support/pi-test-harness/playbook";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  resolveTranscriptTools,
  type Context,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";

import modesExtension from "../src/extensions/modes.js";
import modelFamilySystemPromptExtension from "../src/extensions/model-family-system-prompt.js";
import dynamicWorkflowsExtension from "../src/extensions/dynamic-workflows/extension.js";
import searchToolsExtension from "../src/extensions/search-tools.js";
import { registerPiAiProvider } from "../src/extensions/pi-ai-models.js";
import {
  defineModesFile,
  registerBuiltInModes,
  unregisterBuiltInModes,
} from "../src/mode-utils.js";
import { createTempDirSync } from "./test-utils/temp-paths.js";

const MODE_SOURCE = "test-rpc-selection";

afterEach(() => {
  unregisterBuiltInModes(MODE_SOURCE);
  vi.unstubAllEnvs();
});

test("RPC controller model and thinking selection overrides restored persisted mode", async () => {
  const provider = createRpcTestProvider();
  let session: TestSession | undefined;
  const systemPrompts: string[] = [];
  const forcedPrompts: Array<string | undefined> = [];

  registerBuildMode();

  try {
    session = await createTestSession({
      extensionFactories: [
        modelFamilySystemPromptExtension,
        modesExtension,
        dynamicWorkflowsExtension,
        (pi) => {
          pi.on("before_agent_start", (event) => {
            systemPrompts.push(event.systemPrompt);
            forcedPrompts.push(event.systemPromptOptions.forceSystemPrompt);
          });
        },
        provider.extensionFactory,
      ],
    });
    patchHarnessAgent(session);
    await session.session.bindExtensions({ mode: "rpc" });
    expect(session.session.model.id).toBe("build-model");
    expect(session.session.thinkingLevel).toBe("high");

    const externalModel = session.session.modelRuntime
      .getAvailableSnapshot()
      .find(
        (model: { provider: string; id: string }) =>
          model.provider === "rpc-test" && model.id === "external-model",
      );
    expect(externalModel).toBeTruthy();

    await session.session.setModel(externalModel!);
    session.session.setThinkingLevel("low");
    session.events.ui.length = 0;

    await session.run(when("hello", [says("ok")]));

    expect(session.session.model.provider).toBe("rpc-test");
    expect(session.session.model.id).toBe("external-model");
    expect(session.session.thinkingLevel).toBe("low");
    expect(systemPrompts.at(-1)).toContain("BUILD MODE PROMPT");
    expect(forcedPrompts.at(-1)).toBeUndefined();
    expect(
      session.events
        .uiCallsFor("notify")
        .some((call) => String(call.args[0]).includes("primary model restored")),
    ).toBe(false);
  } finally {
    session?.dispose();
    provider.dispose();
  }
});

test("replace mode changes only preamble while preserving Pi sections and tool history", async () => {
  const provider = createRpcTestProvider();
  let session: TestSession | undefined;
  const projectedContexts: Array<
    Array<{ role: string; sections?: Record<string, string>; toolsAdded?: unknown[] }>
  > = [];
  registerBuildMode("replace", ["*"]);

  try {
    session = await createTestSession({
      extensionFactories: [
        modelFamilySystemPromptExtension,
        modesExtension,
        dynamicWorkflowsExtension,
        (pi) => {
          pi.registerTool({
            name: "goal",
            label: "Goal",
            description: "Manage durable autonomous objectives",
            parameters: Type.Object({}),
            execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
          });
        },
        searchToolsExtension,
        (pi) => {
          pi.on("context_with_system", (event) => {
            projectedContexts.push(event.messages);
          });
        },
        provider.extensionFactory,
      ],
    });
    patchHarnessAgent(session);
    await session.session.bindExtensions({ mode: "rpc" });
    const turn = when("load durable goal", [
      calls("search_tools", { query: "durable goal" }),
      says("loaded"),
    ]);
    const { streamFn } = createPlaybookStreamFn([turn]);
    const providerContexts: Context[] = [];
    (session.session.agent as any).streamFunction = (
      model: any,
      context: Context,
      options: any,
    ) => {
      providerContexts.push(context);
      return streamFn(model, context, options);
    };
    (session.session.agent as any).getApiKey = () => "test-key";
    await session.session.prompt(turn.prompt);
    await session.session.agent.waitForIdle();

    const initial = projectedContexts.at(-1)?.find((message) => message.role === "system");
    expect(initial?.sections?.preamble).toBe("BUILD MODE PROMPT");
    expect(initial?.sections?.tools).toBeTruthy();
    expect(initial?.sections?.rules).toBeTruthy();
    expect(initial?.sections?.docs).toBeTruthy();
    expect(initial?.toolsAdded?.length).toBeGreaterThan(0);
    const messages = providerContexts.at(-1)?.messages;
    expect(messages).toBeDefined();
    if (messages === undefined) throw new Error("Expected provider context");
    expect(messages[0]?.role).toBe("system");
    if (messages[0]?.role === "system") {
      expect(messages[0].sections?.preamble).toBe("BUILD MODE PROMPT");
      expect(messages[0].sections?.tools).toBeTruthy();
    }
    expect(resolveTranscriptTools(messages, true).requestTools.map((tool) => tool.name)).toContain(
      "search_tools",
    );
    expect(
      resolveTranscriptTools(messages, true).requestTools.map((tool) => tool.name),
    ).not.toContain("goal");
    expect(
      messages.some(
        (message) =>
          message.role === "system" && message.toolsAdded?.some((tool) => tool.name === "goal"),
      ),
    ).toBe(true);
    await session.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
    expect(session.session.getActiveToolNames()).toContain("goal");
  } finally {
    session?.dispose();
    provider.dispose();
  }
});

for (const systemPromptMode of ["append", "replace"] as const) {
  for (const control of ["env", "flag", "default"] as const) {
    test(`RPC external system prompt with ${systemPromptMode} mode and ${control} control`, async () => {
      if (control === "env") vi.stubEnv("PI_PRESERVE_SYSTEM_PROMPT", "1");
      const provider = createRpcTestProvider();
      let session: TestSession | undefined;
      const systemMessages: Array<{ sections?: Record<string, string> }> = [];
      registerBuildMode(systemPromptMode, ["read"]);

      try {
        session = await createTestSession({
          systemPrompt: "EXTERNAL SYSTEM PROMPT",
          extensionFactories: [
            modelFamilySystemPromptExtension,
            modesExtension,
            (pi) => {
              pi.on("context_with_system", (event) => {
                systemMessages.push(
                  ...event.messages.filter((message) => message.role === "system"),
                );
              });
            },
            provider.extensionFactory,
          ],
        });
        patchHarnessAgent(session);
        await session.session.bindExtensions({ mode: "rpc" });
        if (control === "flag") {
          expect(
            session.session.extensionRunner.getFlags().get("preserve-system-prompt")?.type,
          ).toBe("boolean");
          session.session.extensionRunner.setFlagValue("preserve-system-prompt", true);
        }

        await session.run(when("hello", [says("ok")]));

        const system = systemMessages.at(-1);
        expect(system).toBeDefined();
        if (control === "default") {
          if (systemPromptMode === "append") {
            expect(system?.sections?.preamble).not.toBe("EXTERNAL SYSTEM PROMPT");
            expect(system?.sections?.mode_instructions).toContain("BUILD MODE PROMPT");
          } else {
            expect(system?.sections?.preamble).toBe("BUILD MODE PROMPT");
            expect(system?.sections?.mode_instructions).toBeUndefined();
          }
        } else {
          expect(system?.sections?.preamble).toBe("EXTERNAL SYSTEM PROMPT");
          expect(system?.sections?.mode_instructions).toBeUndefined();
        }
        expect(session.session.model.id).toBe("build-model");
        expect(session.session.thinkingLevel).toBe("high");
        expect(session.session.getActiveToolNames()).toContain("read");
        expect(session.session.getActiveToolNames()).not.toContain("write");
      } finally {
        session?.dispose();
        provider.dispose();
      }
    });
  }
}

test("RPC controller thinking-only override survives prompt startup", async () => {
  const provider = createRpcTestProvider();
  let session: TestSession | undefined;
  registerBuildMode();

  try {
    session = await createTestSession({
      extensionFactories: [modesExtension, provider.extensionFactory],
    });
    patchHarnessAgent(session);
    await session.session.bindExtensions({ mode: "rpc" });
    session.session.setThinkingLevel("low");
    session.events.ui.length = 0;

    await session.run(when("hello", [says("ok")]));

    expect(session.session.model.id).toBe("build-model");
    expect(session.session.thinkingLevel).toBe("low");
    expect(
      session.events
        .uiCallsFor("notify")
        .some((call) => String(call.args[0]).includes("primary model restored")),
    ).toBe(false);
  } finally {
    session?.dispose();
    provider.dispose();
  }
});

test("interactive session still restores active mode primary selection", async () => {
  const provider = createRpcTestProvider();
  let session: TestSession | undefined;
  registerBuildMode();

  try {
    session = await createTestSession({
      extensionFactories: [modesExtension, provider.extensionFactory],
    });
    patchHarnessAgent(session);
    await session.session.bindExtensions({ mode: "tui" });
    const externalModel = getTestModel(session, "external-model");

    await session.session.setModel(externalModel);
    session.session.setThinkingLevel("low");
    session.events.ui.length = 0;

    await session.run(when("hello", [says("ok")]));

    expect(session.session.model.id).toBe("build-model");
    expect(session.session.thinkingLevel).toBe("high");
    expect(
      session.events
        .uiCallsFor("notify")
        .some((call) => String(call.args[0]).includes("primary model restored")),
    ).toBe(true);
  } finally {
    session?.dispose();
    provider.dispose();
  }
});

test("explicit mode command in RPC mode reclaims model and thinking selection", async () => {
  const provider = createRpcTestProvider();
  let session: TestSession | undefined;
  registerBuildMode();

  try {
    session = await createTestSession({
      extensionFactories: [modesExtension, provider.extensionFactory],
    });
    patchHarnessAgent(session);
    await session.session.bindExtensions({ mode: "rpc" });

    await session.session.setModel(getTestModel(session, "external-model"));
    session.session.setThinkingLevel("low");
    await session.session.prompt("/mode build");
    await session.session.agent.waitForIdle();

    expect(session.session.model.id).toBe("build-model");
    expect(session.session.thinkingLevel).toBe("high");

    await session.run(when("hello", [says("ok")]));

    expect(session.session.model.id).toBe("build-model");
    expect(session.session.thinkingLevel).toBe("high");
  } finally {
    session?.dispose();
    provider.dispose();
  }
});

test("RPC session without external override keeps restored mode selection", async () => {
  const provider = createRpcTestProvider();
  let session: TestSession | undefined;
  registerBuildMode();

  try {
    session = await createTestSession({
      extensionFactories: [modesExtension, provider.extensionFactory],
    });
    patchHarnessAgent(session);
    await session.session.bindExtensions({ mode: "rpc" });
    session.events.ui.length = 0;

    await session.run(when("hello", [says("ok")]));

    expect(session.session.model.id).toBe("build-model");
    expect(session.session.thinkingLevel).toBe("high");
    expect(
      session.events
        .uiCallsFor("notify")
        .some((call) => String(call.args[0]).includes("primary model restored")),
    ).toBe(false);
  } finally {
    session?.dispose();
    provider.dispose();
  }
});

test("failover remains active after explicit RPC mode activation", async () => {
  const agentDir = createTempDirSync("agent-modes-rpc-failover-");
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const provider = createRpcTestProvider();
  let session: TestSession | undefined;
  registerBuildMode();

  try {
    session = await createTestSession({
      cwd: agentDir,
      agentDir,
      extensionFactories: [modesExtension, provider.extensionFactory],
    });
    patchHarnessAgent(session);
    await session.session.bindExtensions({ mode: "rpc" });
    await session.session.prompt("/mode build");
    await session.session.agent.waitForIdle();

    await session.session.extensionRunner.emit({
      type: "message_end",
      message: fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "429 RESOURCE_EXHAUSTED retryDelay: 60s",
      }),
    });

    expect(session.session.model.id).toBe("fallback-model");
    expect(session.session.thinkingLevel).toBe("low");

    await session.run(when("hello", [says("ok")]));

    expect(session.session.model.id).toBe("fallback-model");
    expect(session.session.thinkingLevel).toBe("low");
  } finally {
    session?.dispose();
    provider.dispose();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

function registerBuildMode(
  systemPromptMode: "append" | "replace" = "append",
  tools?: string[],
): void {
  registerBuiltInModes(
    MODE_SOURCE,
    defineModesFile({
      version: 1,
      modes: {
        build: {
          provider: "rpc-test",
          modelId: "build-model",
          thinkingLevel: "high",
          systemPrompt: "BUILD MODE PROMPT",
          systemPromptMode,
          tools,
          fallbacks: [{ provider: "rpc-test", modelId: "fallback-model", thinkingLevel: "low" }],
        },
      },
    }),
  );
}

function getTestModel(testSession: TestSession, modelId: string) {
  const model = testSession.session.modelRuntime
    .getAvailableSnapshot()
    .find(
      (candidate: { provider: string; id: string }) =>
        candidate.provider === "rpc-test" && candidate.id === modelId,
    );
  expect(model).toBeTruthy();
  return model!;
}

function patchHarnessAgent(testSession: TestSession): void {
  const agent = testSession.session.agent as {
    state: { tools: unknown[] };
    setTools?: (tools: unknown[]) => void;
  };
  agent.setTools ??= (tools) => {
    agent.state.tools = tools;
  };
}

function createRpcTestProvider(): {
  extensionFactory: (pi: ExtensionAPI) => void;
  dispose: () => void;
} {
  const registration = fauxProvider({
    provider: "rpc-test",
    models: [
      {
        id: "build-model",
        reasoning: true,
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
      {
        id: "external-model",
        reasoning: true,
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
      {
        id: "fallback-model",
        reasoning: true,
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
    ],
  });
  registration.setResponses([fauxAssistantMessage("ok")]);
  const unregisterProvider = registerPiAiProvider(registration.provider);

  return {
    extensionFactory(pi) {
      const model = registration.getModel();
      pi.registerProvider(model.provider, {
        baseUrl: model.baseUrl,
        apiKey: "TEST_KEY",
        api: registration.api,
        streamSimple: registration.provider.streamSimple,
        models: registration.models.map((registeredModel) => ({
          id: registeredModel.id,
          name: registeredModel.name,
          reasoning: registeredModel.reasoning,
          input: registeredModel.input,
          cost: registeredModel.cost,
          contextWindow: registeredModel.contextWindow,
          maxTokens: registeredModel.maxTokens,
        })),
      });
    },
    dispose: unregisterProvider,
  };
}
