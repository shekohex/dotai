import * as acp from "@agentclientprotocol/sdk";
import { describe, expect, test } from "vitest";
import { AcpAgentCore, type AcpManagedSession } from "../../src/acp/core.js";
import { convertV1PromptContent } from "../../src/acp/content.js";
import { createAcpV1Agent } from "../../src/acp/v1/agent.js";

describe("ACP v1 sessions", () => {
  test("creates a session and streams one real prompt through shared core", async () => {
    const updates: acp.SessionNotification[] = [];
    const session = new FakeManagedSession("session-1", "/workspace");
    const core = new AcpAgentCore({
      createSession: () => Promise.resolve(session),
      openSession: () => Promise.resolve(session),
      forkSession: () => Promise.resolve(session),
      listSessions: () => Promise.resolve([]),
      deleteSession: () => Promise.resolve(),
    });
    const client = acp
      .client({ name: "session-test" })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        updates.push(params);
      });

    await client.connectWith(createAcpV1Agent(core), async (connection) => {
      const initialized = await connection.request(acp.methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "session-test", version: "1.0.0" },
      });
      expect(initialized.agentCapabilities.loadSession).toBe(true);

      const created = await connection.request(acp.methods.agent.session.new, {
        cwd: "/workspace",
        mcpServers: [],
      });
      expect(created.sessionId).toBe("session-1");

      const response = await connection.request(acp.methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: "hello" }],
      });
      expect(response.stopReason).toBe("end_turn");
    });

    expect(updates).toEqual([
      {
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello from pi" },
          messageId: "assistant-1",
        },
      },
      {
        sessionId: "session-1",
        update: { sessionUpdate: "config_option_update", configOptions: [] },
      },
    ]);
  });

  test("lists, resumes, closes, and deletes exact sessions", async () => {
    const opened = new FakeManagedSession("session-2", "/workspace");
    const deleted: string[] = [];
    const core = new AcpAgentCore({
      createSession: () => Promise.resolve(opened),
      openSession: (sessionId) => {
        expect(sessionId).toBe("session-2");
        return Promise.resolve(opened);
      },
      forkSession: () => Promise.resolve(opened),
      listSessions: () =>
        Promise.resolve([
          {
            sessionId: "session-2",
            cwd: "/workspace",
            title: "Persisted session",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ]),
      deleteSession: (sessionId) => {
        deleted.push(sessionId);
        return Promise.resolve();
      },
    });

    await acp.client().connectWith(createAcpV1Agent(core), async (connection) => {
      const listed = await connection.request(acp.methods.agent.session.list, {});
      expect(listed.sessions).toEqual([
        {
          sessionId: "session-2",
          cwd: "/workspace",
          title: "Persisted session",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]);
      await connection.request(acp.methods.agent.session.resume, {
        sessionId: "session-2",
        cwd: "/workspace",
      });
      await connection.request(acp.methods.agent.session.close, { sessionId: "session-2" });
      await connection.request(acp.methods.agent.session.delete, { sessionId: "session-2" });
    });

    expect(opened.disposed).toBe(true);
    expect(deleted).toEqual(["session-2"]);
  });

  test("a second prompt cancels the active turn before starting", async () => {
    const session = new ControlledManagedSession("session-3", "/workspace");
    const core = new AcpAgentCore(createDependencies(session));
    await core.createSession("/workspace");

    const firstPrompt = core.prompt(
      "session-3",
      convertV1PromptContent([{ type: "text", text: "first" }]),
      async () => {},
    );
    while (session.prompts.length === 0) await Promise.resolve();
    const secondPrompt = core.prompt(
      "session-3",
      convertV1PromptContent([{ type: "text", text: "second" }]),
      async () => {},
    );

    await expect(firstPrompt).resolves.toBe("cancelled");
    session.finish("end_turn");
    await expect(secondPrompt).resolves.toBe("end_turn");
    expect(session.prompts).toEqual(["first", "second"]);
    expect(session.abortCount).toBe(1);
  });

  test("accepts a replacement prompt while the v1 prompt request is still open", async () => {
    const session = new ControlledManagedSession("session-3-wire", "/workspace");
    const core = new AcpAgentCore(createDependencies(session));

    await acp.client().connectWith(createAcpV1Agent(core), async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "steering-test", version: "1" },
      });
      await connection.request(acp.methods.agent.session.new, {
        cwd: "/workspace",
        mcpServers: [],
      });
      const firstPrompt = connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.id,
        prompt: [{ type: "text", text: "first" }],
      });
      await expect.poll(() => session.prompts).toEqual(["first"]);
      const replacementPrompt = connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.id,
        prompt: [{ type: "text", text: "replacement" }],
      });

      await expect(firstPrompt).resolves.toEqual({ stopReason: "cancelled" });
      await expect.poll(() => session.prompts).toEqual(["first", "replacement"]);
      session.finish("end_turn");
      await expect(replacementPrompt).resolves.toEqual({ stopReason: "end_turn" });
    });

    expect(session.abortCount).toBe(1);
  });

  test("load replays persisted history before returning", async () => {
    const updates: acp.SessionNotification[] = [];
    const session = new FakeManagedSession("session-4", "/workspace", [
      { type: "user_text", text: "question", messageId: "user-1" },
      { type: "text", text: "answer", messageId: "assistant-1" },
    ]);
    const core = new AcpAgentCore(createDependencies(session));
    const client = acp
      .client()
      .onNotification(acp.methods.client.session.update, ({ params }) => updates.push(params));

    await client.connectWith(createAcpV1Agent(core), async (connection) => {
      await connection.request(acp.methods.agent.session.load, {
        sessionId: "session-4",
        cwd: "/workspace",
        mcpServers: [],
      });
      expect(updates.map((update) => update.update.sessionUpdate)).toEqual([
        "user_message_chunk",
        "agent_message_chunk",
      ]);
    });
  });

  test("publishes live command catalog when session starts", async () => {
    const updates: acp.SessionNotification[] = [];
    let sessionCreated = false;
    let commandUpdateAfterResponse = false;
    const session = new FakeManagedSession("session-5", "/workspace");
    session.availableCommands = [
      { name: "mode", description: "Switch mode", inputHint: "mode name" },
      { name: "skill:tdd", description: "Test-driven development" },
    ];
    const core = new AcpAgentCore(createDependencies(session));
    const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => {
      updates.push(params);
      if (params.update.sessionUpdate === "available_commands_update") {
        commandUpdateAfterResponse = sessionCreated;
      }
    });

    await client.connectWith(createAcpV1Agent(core), async (connection) => {
      await connection.request(acp.methods.agent.session.new, {
        cwd: "/workspace",
        mcpServers: [],
      });
      sessionCreated = true;
      await expect.poll(() => updates.length).toBe(1);
    });

    expect(updates).toEqual([
      {
        sessionId: "session-5",
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            {
              name: "mode",
              description: "Switch mode",
              input: { hint: "mode name" },
            },
            { name: "skill:tdd", description: "Test-driven development" },
          ],
        },
      },
    ]);
    expect(commandUpdateAfterResponse).toBe(true);
  });
});

function createDependencies(session: AcpManagedSession) {
  return {
    createSession: () => Promise.resolve(session),
    openSession: () => Promise.resolve(session),
    forkSession: () => Promise.resolve(session),
    listSessions: () => Promise.resolve([]),
    deleteSession: () => Promise.resolve(),
  };
}

class FakeManagedSession implements AcpManagedSession {
  protected listener:
    | ((event: Parameters<Parameters<AcpManagedSession["subscribe"]>[0]>[0]) => void)
    | undefined;
  disposed = false;
  availableCommands: AcpManagedSession["availableCommands"] = [];

  constructor(
    readonly id: string,
    readonly cwd: string,
    private readonly replayEvents: ReturnType<AcpManagedSession["replay"]> = [],
  ) {}

  subscribe(listener: Parameters<AcpManagedSession["subscribe"]>[0]): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  async prompt(): Promise<void> {
    this.listener?.({ type: "text", text: "hello from pi", messageId: "assistant-1" });
    this.listener?.({ type: "settled", stopReason: "end_turn" });
  }

  abort(): Promise<void> {
    return Promise.resolve();
  }

  waitForIdle(): Promise<void> {
    return Promise.resolve();
  }

  replay(): ReturnType<AcpManagedSession["replay"]> {
    return this.replayEvents;
  }

  handleBuiltinCommand(): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }

  dispose(): void {
    this.disposed = true;
  }
}

class ControlledManagedSession extends FakeManagedSession {
  readonly prompts: string[] = [];
  abortCount = 0;
  private currentResolve: (() => void) | undefined;

  override prompt(content: Parameters<AcpManagedSession["prompt"]>[0]): Promise<void> {
    this.prompts.push(content.text);
    return new Promise((resolve) => {
      this.currentResolve = resolve;
    });
  }

  override abort(): Promise<void> {
    this.abortCount += 1;
    this.finish("cancelled");
    return Promise.resolve();
  }

  finish(stopReason: "end_turn" | "cancelled"): void {
    this.listener?.({ type: "settled", stopReason });
    this.currentResolve?.();
    this.currentResolve = undefined;
  }
}
