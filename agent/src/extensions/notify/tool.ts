import { randomUUID } from "node:crypto";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { errorMessage } from "../../utils/error-message.js";
import { createTextComponent, formatToolRail, renderToolError } from "../coreui/tools.js";
import { createNotifyAuthHeaders, resolveNotifyCredential } from "./auth.js";
import { createNotifyClient } from "./client.js";
import { resolveNotifySettings } from "./settings.js";
import {
  NOTIFY_PUBLISH_EVENT,
  NOTIFY_ACTION_RESPONSE_EVENT,
  NotifyCallbackActionSchema,
  NotifyPrioritySchema,
  parsePublishPayload,
  type NotifyPublishPayload,
  type NotifyActionResponseEvent,
} from "./types.js";

const NotifyToolActionSchema = Type.Array(NotifyCallbackActionSchema, { maxItems: 3 });

const NotifyToolParametersSchema = Type.Object(
  {
    message: Type.String({ description: "Message body to send to user." }),
    title: Type.Optional(Type.String({ description: "Short notification title." })),
    priority: Type.Optional(NotifyPrioritySchema),
    tags: Type.Optional(Type.Array(Type.String())),
    markdown: Type.Optional(Type.Boolean()),
    actions: Type.Optional(NotifyToolActionSchema),
    blocking: Type.Optional(
      Type.Boolean({
        description:
          "When true, waits for one callback action response and returns it to you when user selects it. Default false.",
      }),
    ),
  },
  { additionalProperties: false },
);

type NotifyToolParameters = Static<typeof NotifyToolParametersSchema>;

function parseNotifyActionResponse(data: unknown): NotifyActionResponseEvent | null {
  const schema = Type.Object(
    {
      correlationId: Type.String(),
      statusCode: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 })),
      body: Type.Optional(Type.String()),
      headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    },
    { additionalProperties: false },
  );
  if (!Value.Check(schema, data)) {
    return null;
  }
  return Value.Parse(schema, data);
}

function renderSummary(message: string, title?: string): string {
  const prefix = title === undefined ? "notify" : `notify ${title}`;
  return `${prefix}: ${message}`;
}

export function waitForBlockingResponse(
  pi: ExtensionAPI,
  correlationId: string,
  signal: AbortSignal | undefined,
): Promise<NotifyActionResponseEvent> {
  return new Promise((resolve, reject) => {
    const unsubscribe = pi.events.on(NOTIFY_ACTION_RESPONSE_EVENT, (data) => {
      const parsed = parseNotifyActionResponse(data);
      if (parsed === null || parsed.correlationId !== correlationId) {
        return;
      }
      unsubscribe();
      resolve(parsed);
    });
    signal?.addEventListener(
      "abort",
      () => {
        unsubscribe();
        reject(new Error("notify aborted"));
      },
      { once: true },
    );
  });
}

function hasCallbackAction(actions: NotifyToolParameters["actions"]): boolean {
  return (actions?.length ?? 0) > 0;
}

function buildNotifyPayload(
  params: NotifyToolParameters,
  defaultTopic: string,
  correlationId: string,
): NotifyPublishPayload | null {
  const actions =
    params.blocking === true
      ? params.actions?.map((action) => ({ ...action, awaitResponse: true }))
      : params.actions;
  return parsePublishPayload({
    topic: defaultTopic,
    message: params.message,
    title: params.title,
    priority: params.priority,
    tags: params.tags,
    markdown: params.markdown,
    actions,
    meta: { sourceExtension: "notify-tool", eventName: "tool", correlationId },
  });
}

function buildBlockingActionMissingResult() {
  return {
    content: [
      {
        type: "text" as const,
        text: "Error: blocking notify requires at least one callback action.",
      },
    ],
    details: { successes: [], failures: [{ error: "blocking action missing" }] },
    isError: true,
  };
}

function buildInvalidPayloadResult() {
  return {
    content: [{ type: "text" as const, text: "Error: invalid notify payload." }],
    details: { successes: [], failures: [{ error: "invalid payload" }] },
    isError: true,
  };
}

function buildBlockingResponseText(response: NotifyActionResponseEvent): string {
  const bodyText = response.body !== undefined && response.body.length > 0 ? response.body : "OK";
  return [
    "# ntfy Action Response",
    "",
    `- Correlation ID: ${response.correlationId}`,
    `- Status: ${response.statusCode ?? 200}`,
    `- Body: ${bodyText}`,
  ].join("\n");
}

async function executeRuntimeCallbackPath(
  pi: ExtensionAPI,
  payload: NotifyPublishPayload,
  blocking: boolean,
  signal: AbortSignal | undefined,
) {
  pi.events.emit(NOTIFY_PUBLISH_EVENT, payload satisfies NotifyPublishPayload);
  if (!blocking) {
    return {
      content: [{ type: "text" as const, text: "Queued notification with callback actions." }],
      details: { queued: true },
      isError: false,
    };
  }

  try {
    const correlationId = payload.meta?.correlationId;
    if (correlationId === undefined) {
      throw new Error("notify correlation id missing");
    }
    const response = await waitForBlockingResponse(pi, correlationId, signal);
    return {
      content: [{ type: "text" as const, text: buildBlockingResponseText(response) }],
      details: { queued: true, blockingResponse: response },
      isError: false,
    };
  } catch (error) {
    return {
      content: [{ type: "text" as const, text: `Error: ${errorMessage(error)}` }],
      details: { queued: true },
      isError: true,
    };
  }
}

async function executeDirectPublishPath(
  client: ReturnType<typeof createNotifyClient>,
  payload: NotifyPublishPayload,
  auth: Awaited<ReturnType<typeof createNotifyAuthHeaders>>,
  settings: ReturnType<typeof resolveNotifySettings>,
) {
  const result = await client.publishMany({ payload, auth, settings });
  return {
    content: [
      {
        type: "text" as const,
        text: [
          "# ntfy Notification",
          "",
          `- Topic: ${settings.defaultTopic ?? "pi"}`,
          `- Successes: ${result.successes.length}`,
          `- Failures: ${result.failures.length}`,
        ].join("\n"),
      },
    ],
    details: result,
    isError: result.failures.length > 0,
  };
}

export function createNotifyTool(pi: ExtensionAPI) {
  return defineTool({
    name: "notify",
    label: "notify",
    description: "Send ntfy notification to user. Use for concise alerts, approvals, or summaries.",
    promptSnippet:
      "Use `notify` to send short ntfy notifications to user. Prefer concise title/message. Actions use callback style. Only set `blocking=true` when action result is required before continuing.",
    promptGuidelines: [
      "Use `notify` when user should be alerted outside current Pi UI via ntfy.",
      "Keep `notify` messages short and high-signal.",
      "Use `notify.blocking=true` only with callback actions when agent must wait for user action.",
    ],
    parameters: NotifyToolParametersSchema,
    renderCall(args, theme, context) {
      const rail = formatToolRail(theme, context);
      return createTextComponent(
        context.lastComponent,
        `${rail}${renderSummary(args.message, args.title)}`,
      );
    },
    renderResult(result, options, theme, context) {
      if (context.isError) {
        return renderToolError("notify failed", theme, context.lastComponent);
      }
      return createTextComponent(
        context.lastComponent,
        `${formatToolRail(theme, context)}sent notification`,
      );
    },
    async execute(
      _toolCallId,
      params: NotifyToolParameters,
      signal,
      _onUpdate,
      ctx: ExtensionContext,
    ) {
      const settings = resolveNotifySettings();
      const credential = await resolveNotifyCredential(ctx);
      const auth = createNotifyAuthHeaders(credential, settings.allowAnonymous);
      if (!auth.configured && !settings.allowAnonymous) {
        return {
          content: [{ type: "text", text: "Error: ntfy auth missing" }],
          details: { successes: [], failures: [{ error: "ntfy auth missing" }] },
          isError: true,
        };
      }

      const client = createNotifyClient();
      const payload = buildNotifyPayload(params, settings.defaultTopic ?? "pi", randomUUID());
      if (payload === null) {
        return buildInvalidPayloadResult();
      }
      const usesCallbackRuntime = params.blocking === true || hasCallbackAction(params.actions);
      if (params.blocking === true) {
        const hasBlockingAction = (params.actions?.length ?? 0) > 0;
        if (!hasBlockingAction) {
          return buildBlockingActionMissingResult();
        }
      }
      if (usesCallbackRuntime) {
        return executeRuntimeCallbackPath(pi, payload, params.blocking === true, signal);
      }
      return executeDirectPublishPath(client, payload, auth, settings);
    },
  });
}

export default function registerNotifyTool(pi: ExtensionAPI): void {
  pi.registerTool(createNotifyTool(pi));
}
