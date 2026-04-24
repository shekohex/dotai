import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema, type ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { JsonObject, JsonValue } from "./http.js";

export type ResumeAction = "accept" | "decline" | "cancel";

export type ExecutorElicitationRequest =
  | {
      mode: "form";
      message: string;
      requestedSchema: JsonObject;
    }
  | {
      mode: "url";
      message: string;
      url: string;
      elicitationId: string;
    };

export type ExecutorElicitationResponse = {
  action: ResumeAction;
  content?: JsonObject;
};

export type ExecutorMcpToolMetadata = {
  name: string;
  description?: string;
};

export type ExecutorMcpInspection = {
  instructions?: string;
  tools: ExecutorMcpToolMetadata[];
};

export type ExecutorMcpToolResult = {
  text: string;
  structuredContent: JsonValue;
  isError: boolean;
};

type ExecutorMcpClientOptions = {
  hasUI: boolean;
  onElicitation?: (request: ExecutorElicitationRequest) => Promise<ExecutorElicitationResponse>;
};

type ConnectedExecutorMcpClient = {
  inspect: () => Promise<ExecutorMcpInspection>;
  execute: (code: string) => Promise<ExecutorMcpToolResult>;
  resume: (
    executionId: string,
    action: ResumeAction,
    content?: JsonObject,
  ) => Promise<ExecutorMcpToolResult>;
  close: () => Promise<void>;
};

const DEFAULT_TEXT_RESULT = "(no result)";

const TextContentPartSchema = Type.Object(
  {
    type: Type.Literal("text"),
    text: Type.String(),
  },
  { additionalProperties: true },
);

const ExecutorUrlElicitationSchema = Type.Object(
  {
    mode: Type.Literal("url"),
    message: Type.Optional(Type.Unknown()),
    url: Type.Optional(Type.Unknown()),
    elicitationId: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
);

const ExecutorFormElicitationSchema = Type.Object(
  {
    message: Type.Optional(Type.Unknown()),
    requestedSchema: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
);

const buildCapabilities = (hasUI: boolean): ClientCapabilities =>
  hasUI
    ? {
        elicitation: {
          form: {},
          url: {},
        },
      }
    : {};

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null) {
    return true;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item));
  }

  if (typeof value === "object") {
    return Object.values(value).every((item) => isJsonValue(item));
  }

  return false;
};

const isJsonObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value) && isJsonValue(value);

const cloneJsonObject = (value: unknown): JsonObject => {
  const cloned: unknown = JSON.parse(JSON.stringify(value));
  return isJsonObject(cloned) ? cloned : {};
};

const readOptionalString = (value: unknown): string => (typeof value === "string" ? value : "");

const collectText = (content: unknown): string => {
  if (!Array.isArray(content)) {
    return "";
  }

  const textParts: string[] = [];
  for (const item of content) {
    if (!Value.Check(TextContentPartSchema, item)) {
      continue;
    }

    textParts.push(Value.Parse(TextContentPartSchema, item).text);
  }
  return textParts.join("\n").trim();
};

const normalizeToolResult = (
  result: Awaited<ReturnType<Client["callTool"]>>,
): ExecutorMcpToolResult => {
  if (!("content" in result)) {
    return {
      text: JSON.stringify(result.toolResult, null, 2),
      structuredContent: null,
      isError: false,
    };
  }

  const structuredContent =
    result.structuredContent !== undefined && result.structuredContent !== null
      ? cloneJsonObject(result.structuredContent)
      : null;
  const text = collectText(result.content);
  let normalizedText = text;
  if (normalizedText.length === 0) {
    normalizedText =
      structuredContent === null ? DEFAULT_TEXT_RESULT : JSON.stringify(structuredContent, null, 2);
  }

  return {
    text: normalizedText,
    structuredContent,
    isError: result.isError === true,
  };
};

const connectExecutorMcpClient = async (
  mcpUrl: string,
  options: ExecutorMcpClientOptions,
): Promise<ConnectedExecutorMcpClient> => {
  const client = new Client(
    { name: "pi-executor-builtin", version: "0.0.1" },
    { capabilities: buildCapabilities(options.hasUI) },
  );
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));

  registerElicitationHandler(client, options.onElicitation);

  await client.connect(transport);

  return {
    inspect: async () => ({
      instructions: client.getInstructions(),
      tools: await listExecutorTools(client),
    }),
    execute: async (code) =>
      normalizeToolResult(
        await client.callTool({
          name: "execute",
          arguments: { code },
        }),
      ),
    resume: async (executionId, action, content) =>
      normalizeToolResult(
        await client.callTool({
          name: "resume",
          arguments: {
            executionId,
            action,
            content: content ? JSON.stringify(content) : "{}",
          },
        }),
      ),
    close: async () => {
      await transport.terminateSession().catch(() => {});
      await client.close().catch(() => {});
    },
  };
};

function registerElicitationHandler(
  client: Client,
  onElicitation: ExecutorMcpClientOptions["onElicitation"],
): void {
  if (!onElicitation) {
    return;
  }

  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    const response = await onElicitation(toExecutorElicitationRequest(request.params));
    if (response.content !== undefined) {
      return { action: response.action, content: response.content };
    }

    return { action: response.action };
  });
}

function toExecutorElicitationRequest(params: unknown): ExecutorElicitationRequest {
  if (Value.Check(ExecutorUrlElicitationSchema, params)) {
    const parsed = Value.Parse(ExecutorUrlElicitationSchema, params);
    return {
      mode: "url",
      message: readOptionalString(parsed.message),
      url: readOptionalString(parsed.url),
      elicitationId: readOptionalString(parsed.elicitationId),
    };
  }

  const parsed = Value.Check(ExecutorFormElicitationSchema, params)
    ? Value.Parse(ExecutorFormElicitationSchema, params)
    : { message: undefined, requestedSchema: undefined };

  return {
    mode: "form",
    message: readOptionalString(parsed.message),
    requestedSchema: cloneJsonObject(parsed.requestedSchema),
  };
}

async function listExecutorTools(client: Client): Promise<ExecutorMcpToolMetadata[]> {
  const tools: ExecutorMcpToolMetadata[] = [];
  let cursor: string | undefined;
  do {
    const response = await client.listTools(
      cursor !== undefined && cursor.length > 0 ? { cursor } : undefined,
    );
    tools.push(
      ...response.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
      })),
    );
    cursor = response.nextCursor;
  } while (cursor !== undefined && cursor.length > 0);

  return tools;
}

export const withExecutorMcpClient = async <T>(
  mcpUrl: string,
  options: ExecutorMcpClientOptions,
  callback: (client: ConnectedExecutorMcpClient) => Promise<T>,
): Promise<T> => {
  const client = await connectExecutorMcpClient(mcpUrl, options);
  try {
    return await callback(client);
  } finally {
    await client.close();
  }
};

export const inspectExecutorMcp = (
  mcpUrl: string,
  hasUI: boolean,
): Promise<ExecutorMcpInspection> =>
  withExecutorMcpClient(mcpUrl, { hasUI }, (client) => client.inspect());
