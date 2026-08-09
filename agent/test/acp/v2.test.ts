import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import { describe, expect, test } from "vitest";
import { AcpAgentCore, type AcpManagedSession, type AcpPromptContent } from "../../src/acp/core.js";
import { createAcpV2Agent } from "../../src/acp/v2/agent.js";

describe("ACP v2 sessions", () => {
  test("acknowledges prompt before running and reaches idle once", async () => {
    const updates: acp.SessionNotification[] = [];
    const session = new V2Session("session-1");
    const core = new AcpAgentCore(createDependencies(session));
    const client = acp
      .client()
      .onNotification(acp.methods.client.session.update, ({ params }) => updates.push(params));

    await client.connectWith(createAcpV2Agent(core), async (connection) => {
      const initialized = await connection.request(acp.methods.agent.initialize, {
        protocolVersion: 2,
        capabilities: {},
        info: { name: "test", version: "1" },
      });
      expect(initialized.capabilities.session?.mcp).toEqual({ stdio: {} });
      const created = await connection.request(acp.methods.agent.session.new, {
        cwd: "/workspace",
      });
      expect(created.sessionId).toBe("session-1");
      await expect.poll(() => updates.length).toBe(1);

      await expect(
        connection.request(acp.methods.agent.session.prompt, {
          sessionId: "session-1",
          prompt: [{ type: "text", text: "hello" }],
        }),
      ).resolves.toEqual({});
      expect(updates).toEqual([
        expect.objectContaining({
          update: expect.objectContaining({ sessionUpdate: "available_commands_update" }),
        }),
      ]);
      await waitFor(() =>
        updates.some(
          (update) =>
            update.update.sessionUpdate === "state_update" && update.update.state === "idle",
        ),
      );
    });

    expect(
      updates
        .filter((update) => update.update.sessionUpdate === "state_update")
        .map((update) => (update.update as acp.StateUpdate).state),
    ).toEqual(["running", "idle"]);
    expect(
      updates.filter(
        (update) =>
          update.update.sessionUpdate === "state_update" && update.update.state === "idle",
      ),
    ).toHaveLength(1);
    expect(updates).toContainEqual({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "session-1:assistant:1",
        content: { type: "text", text: "hello from pi" },
      },
    });
    expect(updates).toContainEqual({
      sessionId: "session-1",
      update: { sessionUpdate: "config_option_update", configOptions: [] },
    });
  });

  test("overlapping prompt defaults to follow-up and supports namespaced steer", async () => {
    const session = new ControlledV2Session("session-1");
    const core = new AcpAgentCore(createDependencies(session));
    const updates: acp.SessionNotification[] = [];
    const client = acp
      .client()
      .onNotification(acp.methods.client.session.update, ({ params }) => updates.push(params));
    await client.connectWith(createAcpV2Agent(core), async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: 2,
        capabilities: {},
        info: { name: "test", version: "1" },
      });
      await connection.request(acp.methods.agent.session.new, { cwd: "/workspace" });
      await connection.request(acp.methods.agent.session.prompt, {
        sessionId: "session-1",
        prompt: [{ type: "text", text: "first" }],
      });
      await waitFor(() => session.prompts.length === 1);
      await connection.request(acp.methods.agent.session.prompt, {
        sessionId: "session-1",
        prompt: [{ type: "text", text: "second" }],
      });
      await connection.request(acp.methods.agent.session.prompt, {
        sessionId: "session-1",
        prompt: [{ type: "text", text: "third" }],
        _meta: { "shekohex.dev/delivery": "steer" },
      });
      await waitFor(() => session.deliveries.length === 2);
      session.finish();
      await waitFor(() =>
        updates.some(
          (update) =>
            update.update.sessionUpdate === "state_update" && update.update.state === "idle",
        ),
      );
    });

    expect(session.deliveries).toEqual([
      ["second", "followUp"],
      ["third", "steer"],
    ]);
  });
});

class V2Session implements AcpManagedSession {
  readonly cwd = "/workspace";
  readonly availableCommands = [{ name: "mode", description: "Switch mode" }];
  protected listener: Parameters<AcpManagedSession["subscribe"]>[0] | undefined;

  constructor(readonly id: string) {}

  subscribe(listener: Parameters<AcpManagedSession["subscribe"]>[0]): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  async prompt(): Promise<void> {
    this.listener?.({ type: "text", text: "hello from pi" });
    this.listener?.({ type: "settled", stopReason: "end_turn" });
  }

  deliver(): Promise<void> {
    return Promise.resolve();
  }

  abort(): Promise<void> {
    return Promise.resolve();
  }

  waitForIdle(): Promise<void> {
    return Promise.resolve();
  }

  replay() {
    return [];
  }

  handleBuiltinCommand(): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }

  dispose(): void {}
}

class ControlledV2Session extends V2Session {
  readonly prompts: string[] = [];
  readonly deliveries: Array<[string, "followUp" | "steer"]> = [];
  private resolvePrompt: (() => void) | undefined;

  override prompt(content: AcpPromptContent): Promise<void> {
    this.prompts.push(content.text);
    return new Promise((resolve) => {
      this.resolvePrompt = resolve;
    });
  }

  override deliver(content: AcpPromptContent, delivery: "followUp" | "steer"): Promise<void> {
    this.deliveries.push([content.text, delivery]);
    return Promise.resolve();
  }

  finish(): void {
    this.listener?.({ type: "settled", stopReason: "end_turn" });
    this.resolvePrompt?.();
  }
}

function createDependencies(session: AcpManagedSession) {
  return {
    createSession: () => Promise.resolve(session),
    openSession: () => Promise.resolve(session),
    forkSession: () => Promise.resolve(session),
    listSessions: () => Promise.resolve([]),
    deleteSession: () => Promise.resolve(),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  await expect.poll(predicate).toBe(true);
}
