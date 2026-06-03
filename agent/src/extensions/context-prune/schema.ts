import { Type, type Static } from "typebox";

export const ContextPruneToolsConfigFileSchema = Type.Object({
  contextPrune: Type.Boolean(),
  contextTreeQuery: Type.Boolean(),
});

export const ContextPruneToolsConfigPatchSchema = Type.Partial(
  Type.Object({
    contextPrune: Type.Boolean(),
    contextTreeQuery: Type.Boolean(),
  }),
);

export const ContextPruneConfigFileSchema = Type.Partial(
  Type.Object({
    enabled: Type.Boolean(),
    tools: Type.Unknown(),
    showPruneStatusLine: Type.Boolean(),
    summarizerModels: Type.Array(Type.String()),
    summarizerThinking: Type.Union([
      Type.Literal("default"),
      Type.Literal("off"),
      Type.Literal("minimal"),
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
      Type.Literal("xhigh"),
    ]),
    pruneOn: Type.Union([
      Type.Literal("every-turn"),
      Type.Literal("on-context-tag"),
      Type.Literal("on-demand"),
      Type.Literal("agent-message"),
      Type.Literal("agentic-auto"),
    ]),
    remindUnprunedCount: Type.Boolean(),
    batchingMode: Type.Union([Type.Literal("turn"), Type.Literal("agent-message")]),
    minRawCharsToPrune: Type.Number({ minimum: 0 }),
  }),
);

export const ContextPruneOverrideSchema = Type.Partial(
  Type.Object({
    enabled: Type.Boolean(),
    tools: ContextPruneToolsConfigPatchSchema,
    showPruneStatusLine: Type.Boolean(),
    summarizerModels: Type.Array(Type.String()),
    summarizerThinking: Type.Union([
      Type.Literal("default"),
      Type.Literal("off"),
      Type.Literal("minimal"),
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
      Type.Literal("xhigh"),
    ]),
    pruneOn: Type.Union([
      Type.Literal("every-turn"),
      Type.Literal("on-context-tag"),
      Type.Literal("on-demand"),
      Type.Literal("agent-message"),
      Type.Literal("agentic-auto"),
    ]),
    remindUnprunedCount: Type.Boolean(),
    batchingMode: Type.Union([Type.Literal("turn"), Type.Literal("agent-message")]),
    minRawCharsToPrune: Type.Number({ minimum: 0 }),
  }),
);

export type ContextPruneConfigFile = Static<typeof ContextPruneConfigFileSchema>;
