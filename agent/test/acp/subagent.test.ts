import * as acp from "@agentclientprotocol/sdk";
import type { AgentSessionEvent, InlineExtension } from "@earendil-works/pi-coding-agent";
import { calls, createTestSession, says, when, type TestSession } from "@support/pi-test-harness";
import { describe, expect, test } from "vitest";
import { AcpAgentCore, type AcpManagedSession } from "../../src/acp/core.js";
import { projectAgentSessionEvent } from "../../src/acp/events.js";
import { installBundledResourcePaths } from "../../src/extensions/bundled-resources.js";
import { createBundledExtensionFactories } from "../../src/extensions/index.js";
import { createAcpV1Agent } from "../../src/acp/v1/agent.js";

describe("ACP bundled subagent", () => {
  test("invokes actual registered subagent tool and streams its lifecycle", async () => {
    installBundledResourcePaths();
    const testSession = await createTestSession({
      extensionFactories: [
        ...createBundledExtensionFactories({}).map(toFactory),
        (pi) => {
          const activate = (): void => {
            pi.setActiveTools([...new Set([...pi.getActiveTools(), "subagent"])]);
          };
          pi.on("session_start", activate);
          pi.on("before_agent_start", activate);
        },
      ],
    });
    patchHarnessAgent(testSession);
    const managed = new HarnessManagedSession(testSession);
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
        await connection.request(acp.methods.agent.initialize, {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "subagent-test", version: "1" },
        });
        await connection.request(acp.methods.agent.session.new, {
          cwd: testSession.cwd,
          mcpServers: [],
        });
        const response = await connection.request(acp.methods.agent.session.prompt, {
          sessionId: managed.id,
          prompt: [{ type: "text", text: "List subagents" }],
        });
        expect(response.stopReason).toBe("end_turn");
      });
    } finally {
      await core.dispose();
    }

    expect(testSession.events.toolCallsFor("subagent")).toHaveLength(1);
    expect(updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: "tool_call",
            name: "subagent",
            status: "in_progress",
          }),
        }),
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: "tool_call_update",
            status: "completed",
          }),
        }),
      ]),
    );
  }, 20_000);
});

class HarnessManagedSession implements AcpManagedSession {
  readonly id: string;
  readonly cwd: string;
  readonly availableCommands = [];

  constructor(private readonly testSession: TestSession) {
    this.id = testSession.session.sessionId;
    this.cwd = testSession.cwd;
  }

  subscribe(listener: Parameters<AcpManagedSession["subscribe"]>[0]): () => void {
    return this.testSession.session.subscribe((event: AgentSessionEvent) => {
      const projected = projectAgentSessionEvent(this.testSession.session, event);
      if (projected !== undefined) listener(projected);
    });
  }

  prompt(content: Parameters<AcpManagedSession["prompt"]>[0]): Promise<void> {
    return this.testSession.run(
      when(content.text, [calls("subagent", { action: "list" }), says("Subagent list complete.")]),
    );
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

function toFactory(extension: InlineExtension): (pi: never) => void {
  return typeof extension === "function" ? extension : extension.factory;
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
