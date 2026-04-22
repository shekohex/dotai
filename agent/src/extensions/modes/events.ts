import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ModeSpec } from "../../mode-utils.js";

export type SessionModel = NonNullable<ExtensionContext["model"]>;

export type ModeChangeReason = "apply" | "store" | "restore" | "sync" | "cycle";
export type ModeChangeSource =
  | "command"
  | "shortcut"
  | "session_start"
  | "model_select"
  | "before_agent_start";

export type ModeActivateEvent = {
  ctx: ExtensionContext;
  mode: string;
  spec?: ModeSpec;
  reason: ModeChangeReason;
  source: ModeChangeSource;
};

export type ModeSelectionApplyEvent = {
  ctx: ExtensionContext;
  mode?: string;
  targetModel?: SessionModel;
  thinkingLevel?: ModeSpec["thinkingLevel"];
  reason: ModeChangeReason;
  source: ModeChangeSource;
  done?: {
    resolve: () => void;
    reject: (error: unknown) => void;
  };
};

const ThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
]);
const UnknownRecordSchema = Type.Record(Type.String(), Type.Unknown());

const ModeStateEntrySchema = Type.Object(
  {
    data: Type.Optional(
      Type.Object({
        activeMode: Type.Optional(Type.String()),
      }),
    ),
  },
  { additionalProperties: true },
);

const ModeActivateEventSchema = Type.Object(
  {
    ctx: Type.Unknown(),
    mode: Type.String(),
    spec: Type.Optional(Type.Unknown()),
    reason: Type.Union([
      Type.Literal("apply"),
      Type.Literal("store"),
      Type.Literal("restore"),
      Type.Literal("sync"),
      Type.Literal("cycle"),
    ]),
    source: Type.Union([
      Type.Literal("command"),
      Type.Literal("shortcut"),
      Type.Literal("session_start"),
      Type.Literal("model_select"),
      Type.Literal("before_agent_start"),
    ]),
  },
  { additionalProperties: true },
);

const ModeSelectionApplyEventSchema = Type.Object(
  {
    ctx: Type.Unknown(),
    mode: Type.Optional(Type.String()),
    targetModel: Type.Optional(Type.Unknown()),
    thinkingLevel: Type.Optional(ThinkingLevelSchema),
    reason: Type.Union([
      Type.Literal("apply"),
      Type.Literal("store"),
      Type.Literal("restore"),
      Type.Literal("sync"),
      Type.Literal("cycle"),
    ]),
    source: Type.Union([
      Type.Literal("command"),
      Type.Literal("shortcut"),
      Type.Literal("session_start"),
      Type.Literal("model_select"),
      Type.Literal("before_agent_start"),
    ]),
    done: Type.Optional(Type.Object({ resolve: Type.Unknown(), reject: Type.Unknown() })),
  },
  { additionalProperties: true },
);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!Value.Check(UnknownRecordSchema, value)) {
    return undefined;
  }

  return Value.Parse(UnknownRecordSchema, value);
}

export function isThinkingLevel(value: unknown): value is NonNullable<ModeSpec["thinkingLevel"]> {
  return Value.Check(ThinkingLevelSchema, value);
}

export function readActiveModeFromEntry(value: unknown): string | undefined {
  if (!Value.Check(ModeStateEntrySchema, value)) {
    return undefined;
  }

  return Value.Parse(ModeStateEntrySchema, value).data?.activeMode;
}

function isExtensionContextLike(value: unknown): value is ExtensionContext {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return (
    "cwd" in value &&
    typeof value.cwd === "string" &&
    "sessionManager" in value &&
    typeof value.sessionManager === "object" &&
    "ui" in value &&
    typeof value.ui === "object"
  );
}

function isModeSpecLike(value: unknown): value is ModeSpec {
  const record = asRecord(value);
  if (!record) {
    return false;
  }

  const provider: unknown = record.provider;
  if (provider !== undefined && typeof provider !== "string") {
    return false;
  }

  const modelId: unknown = record.modelId;
  if (modelId !== undefined && typeof modelId !== "string") {
    return false;
  }

  const thinkingLevel: unknown = record.thinkingLevel;
  if (thinkingLevel !== undefined && !isThinkingLevel(thinkingLevel)) {
    return false;
  }

  const tools: unknown = record.tools;
  if (
    tools !== undefined &&
    (!Array.isArray(tools) || !tools.every((tool) => typeof tool === "string"))
  ) {
    return false;
  }

  return true;
}

function isSessionModelLike(value: unknown): value is SessionModel {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "provider" in value &&
    typeof value.provider === "string" &&
    "id" in value &&
    typeof value.id === "string"
  );
}

function isDoneCallbacks(
  value: unknown,
): value is { resolve: () => void; reject: (error: unknown) => void } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "resolve" in value &&
    typeof value.resolve === "function" &&
    "reject" in value &&
    typeof value.reject === "function"
  );
}

export function parseModeActivateEvent(data: unknown): ModeActivateEvent | undefined {
  if (!Value.Check(ModeActivateEventSchema, data)) {
    return undefined;
  }

  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }

  const ctx = "ctx" in data ? data.ctx : undefined;
  if (!isExtensionContextLike(ctx)) {
    return undefined;
  }

  const mode = "mode" in data ? data.mode : undefined;
  const spec = "spec" in data ? data.spec : undefined;
  const reason = "reason" in data ? data.reason : undefined;
  const source = "source" in data ? data.source : undefined;
  if (typeof mode !== "string" || typeof reason !== "string" || typeof source !== "string") {
    return undefined;
  }

  return {
    ctx,
    mode,
    spec: isModeSpecLike(spec) ? spec : undefined,
    reason,
    source,
  };
}

export function parseModeSelectionApplyEvent(data: unknown): ModeSelectionApplyEvent | undefined {
  if (!Value.Check(ModeSelectionApplyEventSchema, data)) {
    return undefined;
  }

  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }

  const ctx = "ctx" in data ? data.ctx : undefined;
  if (!isExtensionContextLike(ctx)) {
    return undefined;
  }

  const mode = "mode" in data ? data.mode : undefined;
  const reason = "reason" in data ? data.reason : undefined;
  const source = "source" in data ? data.source : undefined;
  if (typeof mode !== "string" || typeof reason !== "string" || typeof source !== "string") {
    return undefined;
  }

  const targetModel = "targetModel" in data ? data.targetModel : undefined;
  const thinkingLevel = "thinkingLevel" in data ? data.thinkingLevel : undefined;
  const done = "done" in data ? data.done : undefined;
  const resolvedThinkingLevel =
    thinkingLevel === undefined ||
    thinkingLevel === "off" ||
    thinkingLevel === "minimal" ||
    thinkingLevel === "low" ||
    thinkingLevel === "medium" ||
    thinkingLevel === "high" ||
    thinkingLevel === "xhigh"
      ? thinkingLevel
      : undefined;

  return {
    ctx,
    mode,
    targetModel: isSessionModelLike(targetModel) ? targetModel : undefined,
    thinkingLevel: resolvedThinkingLevel,
    reason,
    source,
    done: isDoneCallbacks(done) ? done : undefined,
  };
}
