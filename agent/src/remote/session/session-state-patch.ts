import type { SessionSyncEvent } from "../schemas.js";
import type { SessionLiveEventBus } from "../live-events.js";
import { sanitizeRemoteModel } from "../schema-normalization.js";
import type { SessionRecord } from "./types.js";

export type SessionStatePatchPayload = Extract<
  Extract<SessionSyncEvent, { type: "patch" }>["patch"],
  { patchType: "session.state" }
>["payload"];

export function publishSessionStatePatch(input: {
  liveEvents: SessionLiveEventBus | undefined;
  sessionId: string;
  version: string;
  payload: SessionStatePatchPayload;
  ts: number;
}): void {
  void input.ts;
  input.liveEvents?.publishSessionSyncEvent(input.sessionId, {
    type: "patch",
    sessionId: input.sessionId,
    version: input.version,
    patch: { patchType: "session.state", payload: input.payload },
  });
}

export function buildReloadSessionStatePatchPayload(
  record: Pick<
    SessionRecord,
    | "queue"
    | "cwd"
    | "extensions"
    | "settings"
    | "availableModels"
    | "modelSettings"
    | "autoCompactionEnabled"
    | "steeringMode"
    | "followUpMode"
  >,
  resources: SessionStatePatchPayload["patch"]["resources"],
): SessionStatePatchPayload {
  return {
    commandId: "server-reload",
    sequence: record.queue.nextSequence,
    patch: {
      cwd: record.cwd,
      extensions: record.extensions.map((extension) => ({ ...extension })),
      resources,
      settings: { ...record.settings },
      availableModels: record.availableModels.map((model) => sanitizeRemoteModel(model)),
      modelSettings: {
        defaultProvider: record.modelSettings.defaultProvider,
        defaultModel: record.modelSettings.defaultModel,
        defaultThinkingLevel: record.modelSettings.defaultThinkingLevel,
        enabledModels: record.modelSettings.enabledModels
          ? [...record.modelSettings.enabledModels]
          : null,
      },
      autoCompactionEnabled: record.autoCompactionEnabled,
      steeringMode: record.steeringMode,
      followUpMode: record.followUpMode,
    },
  };
}
