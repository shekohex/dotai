import * as acp from "@agentclientprotocol/sdk";
import { describe, expect, test } from "vitest";
import { AcpAgentCore, type AcpConfigOption, type AcpManagedSession } from "../../src/acp/core.js";
import { createAcpV1Agent } from "../../src/acp/v1/agent.js";

describe("ACP session config", () => {
  test("publishes options and applies changes only to target session", async () => {
    const first = new ConfigSession("first");
    const second = new ConfigSession("second");
    const core = new AcpAgentCore({
      createSession: (cwd) => Promise.resolve(cwd.endsWith("first") ? first : second),
      openSession: () => Promise.resolve(first),
      forkSession: () => Promise.resolve(first),
      listSessions: () => Promise.resolve([]),
      deleteSession: () => Promise.resolve(),
    });

    await acp.client().connectWith(createAcpV1Agent(core), async (connection) => {
      const firstResponse = await connection.request(acp.methods.agent.session.new, {
        cwd: "/first",
        mcpServers: [],
      });
      await connection.request(acp.methods.agent.session.new, {
        cwd: "/second",
        mcpServers: [],
      });
      expect(firstResponse.configOptions).toEqual(first.options);

      const changed = await connection.request(acp.methods.agent.session.setConfigOption, {
        sessionId: "first",
        configId: "thinking",
        value: "high",
      });
      expect(changed.configOptions[0]).toMatchObject({ currentValue: "high" });
    });

    expect(first.changes).toEqual([["thinking", "high"]]);
    expect(second.changes).toEqual([]);
  });

  test("rejects stale option without changing state", async () => {
    const session = new ConfigSession("first");
    const core = new AcpAgentCore(createDependencies(session));
    await core.createSession("/first");
    await expect(core.setConfigOption("first", "missing", "value")).rejects.toThrow(
      "Unknown ACP config option",
    );
    expect(session.changes).toEqual([]);
  });
});

class ConfigSession implements AcpManagedSession {
  readonly cwd = `/${this.id}`;
  readonly availableCommands = [];
  readonly changes: Array<[string, string | boolean]> = [];
  readonly options: AcpConfigOption[] = [
    {
      id: "thinking",
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue: "medium",
      options: [
        { value: "medium", name: "medium" },
        { value: "high", name: "high" },
      ],
    },
  ];

  constructor(readonly id: string) {}

  subscribe(): () => void {
    return () => {};
  }

  prompt(): Promise<void> {
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

  getConfigOptions(): Promise<AcpConfigOption[]> {
    return Promise.resolve(this.options);
  }

  setConfigOption(configId: string, value: string | boolean): Promise<void> {
    this.changes.push([configId, value]);
    this.options[0] = { ...this.options[0], currentValue: String(value) };
    return Promise.resolve();
  }

  dispose(): void {}
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
