import * as acp from "@agentclientprotocol/sdk";
import { AcpAgentCore, type AcpManagedSession, type AcpSessionEvent } from "../core.js";
import { convertV1PromptContent } from "../content.js";
import { createAcpV1Ui } from "./ui.js";
import { createV1ClientBridge, type V1ClientCapabilities } from "../client-bridge.js";

export function createAcpV1Agent(core?: AcpAgentCore): acp.AgentApp {
  let supportsElicitation = false;
  let clientBridgeCapabilities: V1ClientCapabilities = {
    readTextFile: false,
    writeTextFile: false,
    terminal: false,
  };
  const agent = acp
    .agent({ name: "pi-acp-v1" })
    .onRequest(acp.methods.agent.initialize, ({ params }) => {
      supportsElicitation = params.clientCapabilities?.elicitation?.form !== undefined;
      clientBridgeCapabilities = {
        readTextFile: params.clientCapabilities?.fs?.readTextFile === true,
        writeTextFile: params.clientCapabilities?.fs?.writeTextFile === true,
        terminal: params.clientCapabilities?.terminal === true,
      };
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: core !== undefined,
          promptCapabilities:
            core === undefined ? undefined : { image: true, embeddedContext: true },
          mcpCapabilities: core === undefined ? undefined : {},
          sessionCapabilities:
            core === undefined
              ? undefined
              : { list: {}, delete: {}, fork: {}, resume: {}, close: {} },
        },
        authMethods: [],
        agentInfo: { name: "pi", version: "0.84.1" },
      };
    });
  if (core === undefined) return agent;
  return agent
    .onRequest(acp.methods.agent.session.new, async ({ params, client }) => {
      const session = await core.createSession(params.cwd, {
        createUi: (sessionId) => createAcpV1Ui(client, sessionId, supportsElicitation),
        createClientBridge: (sessionId) =>
          createV1ClientBridge(client, sessionId, clientBridgeCapabilities),
        mcpServers: toMcpServers(params.mcpServers ?? []),
      });
      scheduleAvailableCommands(client, session);
      return { sessionId: session.id, configOptions: await core.getConfigOptions(session.id) };
    })
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      const content = convertV1PromptContent(params.prompt);
      const stopReason = await core.prompt(params.sessionId, content, (event) =>
        notifySessionEvent(client, params.sessionId, event),
      );
      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: await core.getConfigOptions(params.sessionId),
        },
      });
      if (content.text.trim().startsWith("/reload")) {
        await notifyAvailableCommands(client, core.getSession(params.sessionId));
      }
      return { stopReason };
    })
    .onRequest(acp.methods.agent.session.list, async ({ params }) => ({
      sessions: await core.listSessions(params.cwd ?? undefined),
    }))
    .onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
      const session = await core.loadSession(
        params.sessionId,
        params.cwd,
        (event) => notifySessionEvent(client, params.sessionId, event),
        {
          createUi: (sessionId) => createAcpV1Ui(client, sessionId, supportsElicitation),
          createClientBridge: (sessionId) =>
            createV1ClientBridge(client, sessionId, clientBridgeCapabilities),
          mcpServers: toMcpServers(params.mcpServers ?? []),
        },
      );
      scheduleAvailableCommands(client, session);
      return { configOptions: await core.getConfigOptions(session.id) };
    })
    .onRequest(acp.methods.agent.session.resume, async ({ params, client }) => {
      const session = await core.openSession(params.sessionId, params.cwd, {
        createUi: (sessionId) => createAcpV1Ui(client, sessionId, supportsElicitation),
        createClientBridge: (sessionId) =>
          createV1ClientBridge(client, sessionId, clientBridgeCapabilities),
        mcpServers: toMcpServers(params.mcpServers ?? []),
      });
      scheduleAvailableCommands(client, session);
      return { configOptions: await core.getConfigOptions(session.id) };
    })
    .onRequest(acp.methods.agent.session.fork, async ({ params, client }) => {
      const session = await core.forkSession(params.sessionId, params.cwd, {
        createUi: (sessionId) => createAcpV1Ui(client, sessionId, supportsElicitation),
        createClientBridge: (sessionId) =>
          createV1ClientBridge(client, sessionId, clientBridgeCapabilities),
        mcpServers: toMcpServers(params.mcpServers ?? []),
      });
      scheduleAvailableCommands(client, session);
      return { sessionId: session.id, configOptions: await core.getConfigOptions(session.id) };
    })
    .onRequest(acp.methods.agent.session.setConfigOption, async ({ params }) => ({
      configOptions: await core.setConfigOption(params.sessionId, params.configId, params.value),
    }))
    .onRequest(acp.methods.agent.session.close, async ({ params }) => {
      await core.close(params.sessionId);
      return {};
    })
    .onRequest(acp.methods.agent.session.delete, async ({ params }) => {
      await core.delete(params.sessionId);
      return {};
    })
    .onNotification(acp.methods.agent.session.cancel, async ({ params }) => {
      await core.cancel(params.sessionId);
    });
}

function toMcpServers(servers: acp.McpServer[]) {
  return servers.map((server) => {
    if (!("command" in server)) return { type: server.type, name: server.name };
    return {
      type: "stdio" as const,
      name: server.name,
      command: server.command,
      args: server.args,
      env: Object.fromEntries(server.env.map((entry) => [entry.name, entry.value])),
    };
  });
}

async function notifySessionEvent(
  client: acp.AgentContext,
  sessionId: string,
  event: AcpSessionEvent,
): Promise<void> {
  if (event.type === "settled") return;
  if (event.type === "tool_start") {
    await client.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: event.toolCallId,
        name: event.name,
        title: event.title,
        kind: event.kind,
        status: "in_progress",
        rawInput: event.rawInput,
        locations: event.locations,
      },
    });
    return;
  }
  if (event.type === "tool_update" || event.type === "tool_end") {
    await client.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: event.toolCallId,
        status: event.type === "tool_end" ? event.status : "in_progress",
        rawOutput: event.rawOutput,
        content: event.content?.map((content) => ({ type: "content" as const, content })),
      },
    });
    return;
  }
  const sessionUpdate = messageSessionUpdate(event.type);
  await client.notify(acp.methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate,
      content: { type: "text", text: event.text },
      messageId: event.messageId,
    },
  });
}

function messageSessionUpdate(
  eventType: "user_text" | "text" | "thought",
): "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk" {
  if (eventType === "user_text") return "user_message_chunk";
  if (eventType === "text") return "agent_message_chunk";
  return "agent_thought_chunk";
}

async function notifyAvailableCommands(
  client: acp.AgentContext,
  session: AcpManagedSession,
): Promise<void> {
  if (session.availableCommands.length === 0) return;
  await client.notify(acp.methods.client.session.update, {
    sessionId: session.id,
    update: {
      sessionUpdate: "available_commands_update",
      availableCommands: session.availableCommands.map((command) => ({
        name: command.name,
        description: command.description,
        input: command.inputHint === undefined ? undefined : { hint: command.inputHint },
      })),
    },
  });
}

function scheduleAvailableCommands(client: acp.AgentContext, session: AcpManagedSession): void {
  setTimeout(() => {
    void notifyAvailableCommands(client, session).catch(() => {});
  }, 0);
}
