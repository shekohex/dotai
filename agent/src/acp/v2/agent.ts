import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import { convertV1PromptContent } from "../content.js";
import {
  AcpAgentCore,
  type AcpConfigOption,
  type AcpManagedSession,
  type AcpSessionServices,
  type AcpSessionEvent,
} from "../core.js";
import { createAcpV2Ui } from "./ui.js";
import { errorMessage } from "../../utils/error-message.js";
import { isRecord } from "../../utils/unknown-data.js";

const DELIVERY_META_KEY = "shekohex.dev/delivery";

export function createAcpV2Agent(core?: AcpAgentCore): acp.AgentApp {
  const runningSessions = new Set<string>();
  const turnNumbers = new Map<string, number>();
  let supportsElicitation = false;
  const agent = acp
    .agent({ name: "pi-acp-v2" })
    .onRequest(acp.methods.agent.initialize, ({ params }) => {
      supportsElicitation = params.capabilities?.elicitation?.form !== undefined;
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        info: { name: "pi", version: "0.84.1" },
        capabilities:
          core === undefined
            ? {}
            : {
                session: {
                  prompt: { image: {}, embeddedContext: {} },
                  mcp: { stdio: {} },
                  delete: {},
                  fork: {},
                  _meta: { [DELIVERY_META_KEY]: ["followUp", "steer"] },
                },
              },
        authMethods: [],
      };
    });
  if (core === undefined) return agent;
  return agent
    .onRequest(acp.methods.agent.session.new, async ({ params, client }) => {
      const session = await core.createSession(params.cwd, {
        ...createV2SessionServices(client, supportsElicitation, params.mcpServers ?? []),
      });
      scheduleAvailableCommands(client, session);
      return {
        sessionId: session.id,
        configOptions: toV2ConfigOptions(await core.getConfigOptions(session.id)),
      };
    })
    .onRequest(acp.methods.agent.session.list, async ({ params }) => ({
      sessions: await core.listSessions(params.cwd ?? undefined),
    }))
    .onRequest(acp.methods.agent.session.resume, async ({ params, client }) => {
      const emit = createEventEmitter(
        client,
        params.sessionId,
        nextTurn(turnNumbers, params.sessionId),
      );
      const session =
        params.replayFrom?.type === "start"
          ? await core.loadSession(params.sessionId, params.cwd, emit, {
              ...createV2SessionServices(client, supportsElicitation, params.mcpServers ?? []),
            })
          : await core.openSession(params.sessionId, params.cwd, {
              ...createV2SessionServices(client, supportsElicitation, params.mcpServers ?? []),
            });
      scheduleAvailableCommands(client, session);
      return { configOptions: toV2ConfigOptions(await core.getConfigOptions(session.id)) };
    })
    .onRequest(acp.methods.agent.session.fork, async ({ params, client }) => {
      const session = await core.forkSession(params.sessionId, params.cwd, {
        ...createV2SessionServices(client, supportsElicitation, params.mcpServers ?? []),
      });
      scheduleAvailableCommands(client, session);
      return {
        sessionId: session.id,
        configOptions: toV2ConfigOptions(await core.getConfigOptions(session.id)),
      };
    })
    .onRequest(acp.methods.agent.session.close, async ({ params }) => {
      runningSessions.delete(params.sessionId);
      await core.close(params.sessionId);
      return {};
    })
    .onRequest(acp.methods.agent.session.delete, async ({ params }) => {
      runningSessions.delete(params.sessionId);
      await core.delete(params.sessionId);
      return {};
    })
    .onRequest(acp.methods.agent.session.setConfigOption, async ({ params }) => ({
      configOptions: toV2ConfigOptions(
        await core.setConfigOption(params.sessionId, params.configId, configValue(params)),
      ),
    }))
    .onRequest(acp.methods.agent.session.prompt, ({ params, client }) => {
      const content = convertV1PromptContent(params.prompt);
      const delivery = requestedDelivery(params._meta);
      if (runningSessions.has(params.sessionId)) {
        setTimeout(() => {
          void core.deliver(params.sessionId, content, delivery).catch((error: unknown) => {
            void notifyPromptFailure(client, params.sessionId, error);
          });
        }, 0);
        return {};
      }
      runningSessions.add(params.sessionId);
      const turn = nextTurn(turnNumbers, params.sessionId);
      setTimeout(() => {
        void runPrompt(core, client, params.sessionId, content, turn).finally(() => {
          runningSessions.delete(params.sessionId);
        });
      }, 0);
      return {};
    })
    .onNotification(acp.methods.agent.session.cancel, async ({ params }) => {
      await core.cancel(params.sessionId);
    });
}

async function runPrompt(
  core: AcpAgentCore,
  client: acp.AgentContext,
  sessionId: string,
  content: ReturnType<typeof convertV1PromptContent>,
  turn: number,
): Promise<void> {
  await notify(client, sessionId, {
    sessionUpdate: "user_message",
    messageId: messageId(sessionId, "user", turn),
    content: promptBlocks(content),
  });
  await notify(client, sessionId, { sessionUpdate: "state_update", state: "running" });
  try {
    const stopReason = await core.prompt(
      sessionId,
      content,
      createEventEmitter(client, sessionId, turn),
    );
    await notify(client, sessionId, {
      sessionUpdate: "config_option_update",
      configOptions: toV2ConfigOptions(await core.getConfigOptions(sessionId)),
    });
    await notify(client, sessionId, { sessionUpdate: "state_update", state: "idle", stopReason });
  } catch (error) {
    await notifyPromptFailure(client, sessionId, error);
  }
}

function createEventEmitter(client: acp.AgentContext, sessionId: string, turn: number) {
  return (event: AcpSessionEvent): Promise<void> => {
    if (event.type === "settled") return Promise.resolve();
    if (event.type === "user_text") {
      return notify(client, sessionId, {
        sessionUpdate: "user_message_chunk",
        messageId: event.messageId ?? messageId(sessionId, "user", turn),
        content: { type: "text", text: event.text },
      });
    }
    if (event.type === "text" || event.type === "thought") {
      return notify(client, sessionId, {
        sessionUpdate: event.type === "text" ? "agent_message_chunk" : "agent_thought_chunk",
        messageId:
          event.messageId ??
          messageId(sessionId, event.type === "text" ? "assistant" : "thought", turn),
        content: { type: "text", text: event.text },
      });
    }
    if (event.type === "tool_start") {
      if (event.name === "bash") {
        return notifyBashStart(client, sessionId, event);
      }
      return notify(client, sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: event.toolCallId,
        name: event.name,
        title: event.title,
        kind: event.kind,
        status: "in_progress",
        rawInput: event.rawInput,
        locations: event.locations,
      });
    }
    if (event.name === "bash") {
      return notifyBashProgress(client, sessionId, event);
    }
    return notify(client, sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: event.toolCallId,
      status: event.type === "tool_end" ? event.status : "in_progress",
      rawOutput: event.rawOutput,
      content: event.content?.map((content) => ({ type: "content" as const, content })),
    });
  };
}

async function notifyBashStart(
  client: acp.AgentContext,
  sessionId: string,
  event: Extract<AcpSessionEvent, { type: "tool_start" }>,
): Promise<void> {
  const terminalId = `terminal:${event.toolCallId}`;
  const rawInput = isRecord(event.rawInput) ? event.rawInput : {};
  await notify(client, sessionId, {
    sessionUpdate: "terminal_update",
    terminalId,
    command: typeof rawInput.command === "string" ? rawInput.command : null,
    cwd: null,
  });
  await notify(client, sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: event.toolCallId,
    name: event.name,
    title: event.title,
    kind: event.kind,
    status: "in_progress",
    rawInput: event.rawInput,
    content: [{ type: "terminal", terminalId }],
  });
}

async function notifyBashProgress(
  client: acp.AgentContext,
  sessionId: string,
  event: Extract<AcpSessionEvent, { type: "tool_update" | "tool_end" }>,
): Promise<void> {
  const terminalId = `terminal:${event.toolCallId}`;
  const text = event.content
    ?.map((content) => (content.type === "text" ? content.text : ""))
    .join("");
  if (text !== undefined && text.length > 0) {
    await notify(client, sessionId, {
      sessionUpdate: "terminal_output_chunk",
      terminalId,
      data: Buffer.from(text).toString("base64"),
    });
  }
  if (event.type === "tool_end") {
    await notify(client, sessionId, {
      sessionUpdate: "terminal_update",
      terminalId,
      exitStatus: { exitCode: event.status === "completed" ? 0 : 1 },
    });
  }
  await notify(client, sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: event.toolCallId,
    status: event.type === "tool_end" ? event.status : "in_progress",
    rawOutput: event.rawOutput,
  });
}

async function notifyAvailableCommands(
  client: acp.AgentContext,
  session: AcpManagedSession,
): Promise<void> {
  await notify(client, session.id, {
    sessionUpdate: "available_commands_update",
    availableCommands: session.availableCommands.map((command) => ({
      name: command.name,
      description: command.description,
      input:
        command.inputHint === undefined
          ? undefined
          : { type: "text" as const, hint: command.inputHint },
    })),
  });
}

function scheduleAvailableCommands(client: acp.AgentContext, session: AcpManagedSession): void {
  setTimeout(() => {
    void notifyAvailableCommands(client, session).catch(() => {});
  }, 0);
}

function notify(
  client: acp.AgentContext,
  sessionId: string,
  update: acp.SessionUpdate,
): Promise<void> {
  return client.notify(acp.methods.client.session.update, { sessionId, update });
}

async function notifyPromptFailure(
  client: acp.AgentContext,
  sessionId: string,
  error: unknown,
): Promise<void> {
  const text = errorMessage(error);
  await notify(client, sessionId, {
    sessionUpdate: "agent_message_chunk",
    messageId: `${sessionId}:error`,
    content: { type: "text", text },
  });
  await notify(client, sessionId, {
    sessionUpdate: "state_update",
    state: "idle",
    stopReason: "refusal",
  });
}

function toV2ConfigOptions(options: AcpConfigOption[]): acp.SessionConfigOption[] {
  return options.map((option) => ({
    configId: option.id,
    name: option.name,
    description: option.description,
    category: option.category,
    type: "select",
    currentValue: option.currentValue,
    options: option.options,
  }));
}

function configValue(params: acp.SetSessionConfigOptionRequest): string | boolean {
  if (typeof params.value === "string" || typeof params.value === "boolean") return params.value;
  throw new TypeError(`Unsupported ACP v2 config value type: ${params.type}`);
}

function requestedDelivery(meta: Record<string, unknown> | null | undefined): "followUp" | "steer" {
  return meta?.[DELIVERY_META_KEY] === "steer" ? "steer" : "followUp";
}

function promptBlocks(content: ReturnType<typeof convertV1PromptContent>): acp.ContentBlock[] {
  return [{ type: "text", text: content.text }, ...content.images.map((image) => ({ ...image }))];
}

function nextTurn(turnNumbers: Map<string, number>, sessionId: string): number {
  const turn = (turnNumbers.get(sessionId) ?? 0) + 1;
  turnNumbers.set(sessionId, turn);
  return turn;
}

function messageId(
  sessionId: string,
  role: "user" | "assistant" | "thought",
  turn: number,
): string {
  return `${sessionId}:${role}:${turn}`;
}

function toMcpServers(servers: acp.McpServer[]) {
  return servers.map((server) => {
    const descriptor: unknown = server;
    if (!isRecord(descriptor)) return { type: "unknown", name: "unknown" };
    if (
      descriptor.type !== "stdio" ||
      typeof descriptor.name !== "string" ||
      typeof descriptor.command !== "string"
    ) {
      return {
        type: typeof descriptor.type === "string" ? descriptor.type : "unknown",
        name: typeof descriptor.name === "string" ? descriptor.name : "unknown",
      };
    }
    const args = Array.isArray(descriptor.args)
      ? descriptor.args.filter((value): value is string => typeof value === "string")
      : [];
    const env = Array.isArray(descriptor.env)
      ? descriptor.env.filter(
          (entry): entry is { name: string; value: string } =>
            isRecord(entry) && typeof entry.name === "string" && typeof entry.value === "string",
        )
      : [];
    return {
      type: "stdio" as const,
      name: descriptor.name,
      command: descriptor.command,
      args,
      env: Object.fromEntries(env.map((entry) => [entry.name, entry.value])),
    };
  });
}

function createV2SessionServices(
  client: acp.AgentContext,
  supportsElicitation: boolean,
  mcpServers: acp.McpServer[],
): AcpSessionServices {
  return {
    mcpServers: toMcpServers(mcpServers),
    createUi: (sessionId) =>
      createAcpV2Ui(client, sessionId, supportsElicitation, (waiting) =>
        notify(client, sessionId, {
          sessionUpdate: "state_update",
          state: waiting ? "requires_action" : "running",
        }),
      ),
  };
}
