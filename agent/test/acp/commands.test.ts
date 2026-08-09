import * as acp from "@agentclientprotocol/sdk";
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createTestSession, says, when, type TestSession } from "@support/pi-test-harness";
import { describe, expect, test, vi } from "vitest";
import { buildAcpCommandCatalog, executeHeadlessBuiltin } from "../../src/acp/commands.js";
import { AcpAgentCore, type AcpManagedSession } from "../../src/acp/core.js";
import { projectAgentSessionEvent } from "../../src/acp/events.js";
import { createAcpV1Agent } from "../../src/acp/v1/agent.js";
import { installBundledResourcePaths } from "../../src/extensions/bundled-resources.js";

describe("ACP headless built-ins", () => {
  test.each([
    "/settings",
    "/model",
    "/scoped-models",
    "/export /tmp/session.jsonl",
    "/import /tmp/session.jsonl",
    "/share",
    "/copy",
    "/name ACP session",
    "/session",
    "/changelog",
    "/hotkeys",
    "/fork entry-1",
    "/clone",
    "/tree",
    "/trust",
    "/login openai",
    "/logout openai",
    "/new",
    "/compact keep decisions",
    "/resume session-1",
    "/reload",
    "/quit",
  ])("adapts %s without opening TUI", async (command) => {
    const session = createFakeSession();
    const result = await executeHeadlessBuiltin(session, command);

    expect(result).toEqual(expect.any(String));
  });

  test("returns undefined for extension, template, and skill commands", async () => {
    await expect(
      executeHeadlessBuiltin(createFakeSession(), "/mode review"),
    ).resolves.toBeUndefined();
  });

  test("preserves extension and template precedence over headless built-ins", async () => {
    await expect(
      executeHeadlessBuiltin(
        createFakeSession({ extensionCommands: ["reload"] }),
        "/reload extension",
      ),
    ).resolves.toBeUndefined();
    await expect(
      executeHeadlessBuiltin(createFakeSession({ promptTemplates: ["model"] }), "/model custom"),
    ).resolves.toBeUndefined();
  });

  test("discovers and expands bundled skills and prompt templates through v1 ACP", async () => {
    installBundledResourcePaths();
    const expandedPrompts: string[] = [];
    const testSession = await createTestSession({
      extensionFactories: [
        (pi: ExtensionAPI) => {
          pi.on("before_agent_start", (event) => {
            expandedPrompts.push(event.prompt);
          });
        },
      ],
    });
    patchHarnessAgent(testSession);
    const managed = new PromptManagedSession(testSession);
    const core = new AcpAgentCore({
      createSession: () => Promise.resolve(managed),
      openSession: () => Promise.resolve(managed),
      forkSession: () => Promise.resolve(managed),
      listSessions: () => Promise.resolve([]),
      deleteSession: () => Promise.resolve(),
    });
    const updates: acp.SessionNotification[] = [];
    const client = acp
      .client()
      .onNotification(acp.methods.client.session.update, ({ params }) => updates.push(params));

    try {
      await client.connectWith(createAcpV1Agent(core), async (connection) => {
        let stage = "initialize";
        try {
          await connection.request(acp.methods.agent.initialize, {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: "commands-test", version: "1" },
          });
          stage = "new session";
          await connection.request(acp.methods.agent.session.new, {
            cwd: testSession.cwd,
            mcpServers: [],
          });
          await expect
            .poll(() =>
              updates.some(({ update }) => update.sessionUpdate === "available_commands_update"),
            )
            .toBe(true);
          stage = "skill prompt";
          await connection.request(acp.methods.agent.session.prompt, {
            sessionId: managed.id,
            prompt: [{ type: "text", text: "/skill:run-app verify launch" }],
          });
          stage = "template prompt";
          await connection.request(acp.methods.agent.session.prompt, {
            sessionId: managed.id,
            prompt: [{ type: "text", text: "/concise explain result" }],
          });
        } catch (error) {
          throw new Error(`ACP ${stage} failed`, { cause: error });
        }
      });
    } finally {
      await core.dispose();
    }

    const commandUpdate = updates.find(
      ({ update }) => update.sessionUpdate === "available_commands_update",
    );
    expect(commandUpdate?.update).toEqual(
      expect.objectContaining({
        availableCommands: expect.arrayContaining([
          expect.objectContaining({ name: "skill:run-app" }),
          expect.objectContaining({ name: "concise" }),
        ]),
      }),
    );
    expect(expandedPrompts[0]).toContain('<skill name="run-app"');
    expect(expandedPrompts[0]).toContain("verify launch");
    expect(expandedPrompts[0]).not.toContain("/skill:run-app");
    expect(expandedPrompts[1]).toContain("explain result");
    expect(expandedPrompts[1]).toContain("Be extremely concise.");
    expect(expandedPrompts[1]).not.toContain("/concise");
  });
});

class PromptManagedSession implements AcpManagedSession {
  readonly id: string;
  readonly cwd: string;
  readonly availableCommands;

  constructor(private readonly testSession: TestSession) {
    this.id = testSession.session.sessionId;
    this.cwd = testSession.cwd;
    this.availableCommands = buildAcpCommandCatalog(testSession.session);
  }

  subscribe(listener: Parameters<AcpManagedSession["subscribe"]>[0]): () => void {
    return this.testSession.session.subscribe((event: AgentSessionEvent) => {
      const projected = projectAgentSessionEvent(this.testSession.session, event);
      if (projected !== undefined) listener(projected);
    });
  }

  prompt(content: Parameters<AcpManagedSession["prompt"]>[0]): Promise<void> {
    return this.testSession.run(when(content.text, [says("ok")]));
  }

  deliver(): Promise<void> {
    return Promise.resolve();
  }

  abort(): Promise<void> {
    return this.testSession.session.abort();
  }

  waitForIdle(): Promise<void> {
    return this.testSession.session.waitForIdle();
  }

  replay() {
    return [];
  }

  handleBuiltinCommand(): Promise<string | undefined> {
    return Promise.resolve(void 0);
  }

  dispose(): void {
    this.testSession.dispose();
  }
}

function createFakeSession(
  options: { extensionCommands?: string[]; promptTemplates?: string[] } = {},
): AgentSession {
  return {
    model: { provider: "openai", id: "gpt-test" },
    thinkingLevel: "medium",
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    scopedModels: [],
    getActiveToolNames: () => ["read", "bash"],
    getLastAssistantText: () => "last response",
    getSessionStats: () => ({ sessionId: "session-1", totalMessages: 2 }),
    exportToHtml: () => Promise.resolve("/tmp/session.html"),
    exportToJsonl: () => "/tmp/session.jsonl",
    setSessionName: vi.fn(),
    compact: () => Promise.resolve({ summary: "compacted" }),
    reload: () => Promise.resolve(),
    sessionManager: {
      getCwd: () => "/workspace",
      getLeafId: () => "entry-1",
      createBranchedSession: () => "/tmp/fork.jsonl",
      getTree: () => [],
    },
    promptTemplates: (options.promptTemplates ?? []).map((name) => ({ name })),
    extensionRunner: {
      getRegisteredCommands: () =>
        (options.extensionCommands ?? []).map((invocationName) => ({ invocationName })),
      getModelRegistry: () => ({ getAvailable: () => [], find: () => undefined }),
    },
  } as unknown as AgentSession;
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
