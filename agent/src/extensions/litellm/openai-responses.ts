import {
  appendAssistantMessageDiagnostic,
  createAssistantMessageDiagnostic,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createGrammarToolInputProperties } from "@earendil-works/pi-ai/api/constrained-sampling";
import { streamSimple as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { parseUnknownJson } from "../../utils/unknown-value.js";
import { isSessionFastModeActive } from "../openai-better/fast-routing.js";
import {
  buildCachedRequestBody,
  closeLiteLLMWebSocketSessions,
  completeLiteLLMWebSocketOperation,
  createLiteLLMWebSocketOperation,
  failLiteLLMWebSocketOperation,
  isPreviousResponseNotFoundError,
  isWebSocketConnectionLimitReachedError,
  isWebSocketSseFallbackActive,
  LiteLLMApiError,
  recordWebSocketFailure,
  recordWebSocketSseFallback,
  resetLiteLLMWebSocketDebugStats,
  resolveWebSocketUrl,
  webSocketHeaders,
  type LiteLLMWebSocketOperation,
  type RequestBody,
} from "./responses-websocket.js";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const RequestBodySchema = Type.Object(
  {
    input: Type.Optional(Type.Array(Type.Unknown())),
    previous_response_id: Type.Optional(Type.String()),
    stream: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);
type ParsedRequestBody = Static<typeof RequestBodySchema>;

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  if (init?.headers !== undefined) {
    new Headers(init.headers).forEach((value, name) => {
      headers.set(name, value);
    });
  }
  return headers;
}

async function requestBody(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<ParsedRequestBody> {
  let text: string;
  if (typeof init?.body === "string") text = init.body;
  else if (init?.body instanceof Uint8Array) text = Buffer.from(init.body).toString("utf8");
  else if (input instanceof Request) text = await input.clone().text();
  else throw new Error("LiteLLM Responses request body is unavailable");
  const parsed = parseUnknownJson(text);
  if (!Value.Check(RequestBodySchema, parsed)) {
    throw new Error("LiteLLM Responses request body is invalid");
  }
  return Value.Parse(RequestBodySchema, parsed);
}

function websocketRequestBody(body: ParsedRequestBody): RequestBody {
  const { stream: _stream, ...rest } = body;
  return rest;
}

function cacheSessionId(options: SimpleStreamOptions | undefined): string | undefined {
  return options?.cacheRetention === "none" ? undefined : options?.sessionId;
}

function responseItemsForContinuation(
  model: Model<"openai-responses">,
  context: Context,
  message: AssistantMessage,
): unknown[] {
  const grammarToolInputProperties = createGrammarToolInputProperties(
    context.tools,
    model.compat?.supportsOpenAIGrammarTools ?? false,
  );
  return convertResponsesMessages(model, { messages: [message] }, OPENAI_TOOL_CALL_PROVIDERS, {
    includeSystemPrompt: false,
    grammarToolInputProperties,
  }).filter(
    (item) => item.type !== "function_call_output" && item.type !== "custom_tool_call_output",
  );
}

function createWebSocketFetch(params: {
  model: Model<"openai-responses">;
  options?: SimpleStreamOptions;
  onOperation(operation: LiteLLMWebSocketOperation): void;
  onDiagnostic(diagnostic: ReturnType<typeof createAssistantMessageDiagnostic>): void;
}): typeof globalThis.fetch {
  const fallbackFetch = params.options?.fetch ?? globalThis.fetch;
  const sessionId = cacheSessionId(params.options);
  const transport = params.options?.transport ?? "auto";
  const useCachedContext = transport === "websocket-cached" || transport === "auto";

  return async (input, init) => {
    if (isWebSocketSseFallbackActive(sessionId)) {
      recordWebSocketSseFallback(sessionId);
      return fallbackFetch(input, init);
    }

    let retriedConnectionLimit = false;
    let retriedMissingContinuation = false;
    while (true) {
      const body = websocketRequestBody(await requestBody(input, init));
      try {
        const operation = await createLiteLLMWebSocketOperation({
          httpUrl: requestUrl(input),
          body,
          headers: webSocketHeaders(requestHeaders(input, init)),
          modelId: params.model.id,
          sessionId,
          useCachedContext,
          signal: params.options?.signal,
          idleTimeoutMs: params.options?.timeoutMs,
          connectTimeoutMs: params.options?.websocketConnectTimeoutMs,
          env: params.options?.env,
        });
        params.onOperation(operation);
        return operation.response;
      } catch (error) {
        if (params.options?.signal?.aborted === true) throw error;
        if (isPreviousResponseNotFoundError(error) && !retriedMissingContinuation) {
          retriedMissingContinuation = true;
          continue;
        }
        if (isWebSocketConnectionLimitReachedError(error) && !retriedConnectionLimit) {
          retriedConnectionLimit = true;
          continue;
        }
        if (error instanceof LiteLLMApiError && !isWebSocketConnectionLimitReachedError(error)) {
          throw error;
        }

        params.onDiagnostic(
          createAssistantMessageDiagnostic("provider_transport_failure", error, {
            configuredTransport: transport,
            fallbackTransport: "sse",
            eventsEmitted: false,
            phase: "before_message_stream_start",
            requestBytes: new TextEncoder().encode(JSON.stringify(body)).byteLength,
          }),
        );
        recordWebSocketFailure(sessionId, error);
        recordWebSocketSseFallback(sessionId);
        return fallbackFetch(input, init);
      }
    }
  };
}

export function streamLiteLLMOpenAIResponses(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) {
  if (!isOpenAIResponsesModel(model)) {
    throw new Error(`LiteLLM Responses stream does not support API ${model.api}`);
  }
  const responsesModel = model;
  const effectiveOptions = isSessionFastModeActive(options?.sessionId)
    ? { ...options, serviceTier: "priority" as const }
    : options;
  if ((effectiveOptions?.transport ?? "auto") === "sse") {
    return streamOpenAIResponses(responsesModel, context, effectiveOptions);
  }

  let operation: LiteLLMWebSocketOperation | undefined;
  const diagnostics: ReturnType<typeof createAssistantMessageDiagnostic>[] = [];
  const fetch = createWebSocketFetch({
    model: responsesModel,
    options: effectiveOptions,
    onOperation(nextOperation) {
      operation = nextOperation;
    },
    onDiagnostic(diagnostic) {
      diagnostics.push(diagnostic);
    },
  });
  const inner = streamOpenAIResponses(responsesModel, context, { ...effectiveOptions, fetch });
  const outer = createAssistantMessageEventStream();

  void (async () => {
    for await (const event of inner) {
      if (event.type === "done") {
        for (const diagnostic of diagnostics) {
          appendAssistantMessageDiagnostic(event.message, diagnostic);
        }
        completeLiteLLMWebSocketOperation(
          operation,
          responseItemsForContinuation(responsesModel, context, event.message),
        );
      } else if (event.type === "error") {
        for (const diagnostic of diagnostics) {
          appendAssistantMessageDiagnostic(event.error, diagnostic);
        }
        failLiteLLMWebSocketOperation(operation);
      }
      outer.push(event);
    }
    outer.end();
  })();

  return outer;
}

function isOpenAIResponsesModel(model: Model<Api>): model is Model<"openai-responses"> {
  return model.api === "openai-responses";
}

export const _test = {
  buildCachedRequestBody,
  closeWebSocketSessions: closeLiteLLMWebSocketSessions,
  resetWebSocketDebugStats: resetLiteLLMWebSocketDebugStats,
  resolveWebSocketUrl,
  webSocketHeaders,
};
