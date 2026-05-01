import { Type } from "typebox";
import {
    AssistantMessageEventPayloadSchema,
    RuntimeAssistantMessageSchema,
    ToolExecutionSyncPatchPayloadSchema,
} from "../../schemas-stream.js";

export const RuntimeAgentSessionEventSchema = Type.Union([
    Type.Object({ type: Type.Literal("agent_start") }),
    Type.Object({
        type: Type.Literal("turn_start"),
        turnIndex: Type.Optional(Type.Number()),
        timestamp: Type.Optional(Type.Number()),
    }),
    Type.Object({ type: Type.Literal("agent_end"), messages: Type.Array(Type.Unknown()) }),
    Type.Object({
        type: Type.Literal("turn_end"),
        turnIndex: Type.Optional(Type.Number()),
        message: Type.Unknown(),
        toolResults: Type.Array(Type.Unknown()),
    }),
    Type.Object({ type: Type.Literal("message_start"), message: Type.Unknown() }),
    Type.Object({ type: Type.Literal("message_end"), message: Type.Unknown() }),
    Type.Object({
        type: Type.Literal("message_update"),
        message: RuntimeAssistantMessageSchema,
        assistantMessageEvent: AssistantMessageEventPayloadSchema,
    }),
    ToolExecutionSyncPatchPayloadSchema,
    Type.Object({
        type: Type.Literal("queue_update"),
        steering: Type.Array(Type.String()),
        followUp: Type.Array(Type.String()),
    }),
    Type.Object({
        type: Type.Literal("compaction_start"),
        reason: Type.Union([
            Type.Literal("manual"),
            Type.Literal("threshold"),
            Type.Literal("overflow"),
        ]),
    }),
    Type.Object({
        type: Type.Literal("compaction_end"),
        reason: Type.Union([
            Type.Literal("manual"),
            Type.Literal("threshold"),
            Type.Literal("overflow"),
        ]),
        result: Type.Optional(Type.Unknown()),
        aborted: Type.Boolean(),
        willRetry: Type.Boolean(),
        errorMessage: Type.Optional(Type.String()),
    }),
    Type.Object({
        type: Type.Literal("auto_retry_start"),
        attempt: Type.Number(),
        maxAttempts: Type.Number(),
        delayMs: Type.Number(),
        errorMessage: Type.String(),
    }),
    Type.Object({
        type: Type.Literal("auto_retry_end"),
        success: Type.Boolean(),
        attempt: Type.Number(),
        finalError: Type.Optional(Type.String()),
    }),
]);
