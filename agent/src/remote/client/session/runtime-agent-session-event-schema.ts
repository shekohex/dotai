import { Type } from "typebox";
import {
  AgentLifecycleEventPayloadSchema,
  AssistantMessageEventPayloadSchema,
  CompactionStatusSyncPatchPayloadSchema,
  QueueUpdateSyncPatchPayloadSchema,
  RetryStatusSyncPatchPayloadSchema,
  RuntimeAssistantMessageSchema,
  ToolExecutionSyncPatchPayloadSchema,
} from "../../schemas-stream.js";

export const RuntimeAgentSessionEventSchema = Type.Union([
  AgentLifecycleEventPayloadSchema,
  Type.Object({
    type: Type.Literal("message_update"),
    message: RuntimeAssistantMessageSchema,
    assistantMessageEvent: AssistantMessageEventPayloadSchema,
  }),
  ToolExecutionSyncPatchPayloadSchema,
  QueueUpdateSyncPatchPayloadSchema,
  CompactionStatusSyncPatchPayloadSchema,
  RetryStatusSyncPatchPayloadSchema,
]);
