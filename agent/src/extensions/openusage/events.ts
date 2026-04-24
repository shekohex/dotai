import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { ModeSpecSchema } from "../../mode-utils.js";
import type { OpenUsageAlertEvent, UsageSnapshot } from "./types.js";
import { isSupportedProviderId } from "./types.js";

const UsageMetricSchema = Type.Object(
  {
    used: Type.Number(),
    limit: Type.Number(),
    resetsAt: Type.Optional(Type.String()),
    periodDurationMs: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
);

const UsageSnapshotSchema = Type.Object(
  {
    providerId: Type.String(),
    displayName: Type.String(),
    plan: Type.Optional(Type.String()),
    source: Type.Union([Type.Literal("host"), Type.Literal("cliproxy")]),
    accountLabel: Type.Optional(Type.String()),
    session5h: Type.Optional(UsageMetricSchema),
    weekly: Type.Optional(UsageMetricSchema),
    metricLabels: Type.Optional(Type.Record(Type.String(), Type.String())),
    metricShortLabels: Type.Optional(Type.Record(Type.String(), Type.String())),
    fetchedAt: Type.Number(),
    summary: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

const OpenUsageAlertEventSchema = Type.Object(
  {
    providerId: Type.Union([Type.Literal("codex"), Type.Literal("google"), Type.Literal("zai")]),
    displayName: Type.String(),
    metric: Type.Union([Type.Literal("session5h"), Type.Literal("weekly")]),
    remainingPercent: Type.Number(),
    thresholdPercent: Type.Number(),
    resetsAt: Type.Optional(Type.String()),
    snapshot: UsageSnapshotSchema,
  },
  { additionalProperties: true },
);

const ModeChangedEventSchema = Type.Object(
  {
    mode: Type.Optional(Type.String()),
    previousMode: Type.Optional(Type.String()),
    spec: Type.Optional(ModeSpecSchema),
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
    cwd: Type.String(),
  },
  { additionalProperties: true },
);

export type ModeChangedEvent = Static<typeof ModeChangedEventSchema>;

type ParsedUsageSnapshot = Static<typeof UsageSnapshotSchema>;

export function parseAlertEvent(data: unknown): OpenUsageAlertEvent | undefined {
  if (!Value.Check(OpenUsageAlertEventSchema, data)) {
    return undefined;
  }

  const parsed = Value.Parse(OpenUsageAlertEventSchema, data);
  const snapshot = toUsageSnapshot(parsed.snapshot);
  if (!snapshot) {
    return undefined;
  }

  return {
    ...parsed,
    snapshot,
  };
}

export function parseModeChangedEvent(data: unknown): ModeChangedEvent | undefined {
  if (!Value.Check(ModeChangedEventSchema, data)) {
    return undefined;
  }

  const parsed = Value.Parse(ModeChangedEventSchema, data);
  return {
    mode: parsed.mode,
    previousMode: parsed.previousMode,
    spec: parsed.spec,
    reason: parsed.reason,
    source: parsed.source,
    cwd: parsed.cwd,
  };
}

function toUsageSnapshot(snapshot: ParsedUsageSnapshot): UsageSnapshot | undefined {
  if (!isSupportedProviderId(snapshot.providerId)) {
    return undefined;
  }

  return {
    ...snapshot,
    providerId: snapshot.providerId,
    metricLabels: snapshot.metricLabels,
    metricShortLabels: snapshot.metricShortLabels,
  };
}
