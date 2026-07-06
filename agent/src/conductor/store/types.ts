import { Type, type Static } from "typebox";

export const LifecycleStatusSchema = Type.Union([
  Type.Literal("draft"),
  Type.Literal("ready"),
  Type.Literal("in_progress"),
  Type.Literal("in_review"),
  Type.Literal("done"),
  Type.Literal("blocked"),
]);

export type LifecycleStatus = Static<typeof LifecycleStatusSchema>;

export const HerdrHandlesSchema = Type.Object({
  workspaceId: Type.Optional(Type.String()),
  tabId: Type.Optional(Type.String()),
  paneId: Type.Optional(Type.String()),
});

export type HerdrHandles = Static<typeof HerdrHandlesSchema>;

export const WorkItemSchema = Type.Object({
  projectItemId: Type.String(),
  projectId: Type.Optional(Type.String()),
  owner: Type.String(),
  repo: Type.String(),
  issueId: Type.Optional(Type.String()),
  issueNumber: Type.Number({ minimum: 1 }),
  issueUrl: Type.String(),
  title: Type.String(),
  body: Type.String(),
  labels: Type.Array(Type.String()),
  assignees: Type.Array(Type.String()),
  projectStatus: Type.Optional(Type.String()),
  projectFields: Type.Record(Type.String(), Type.Unknown()),
});

export type WorkItem = Static<typeof WorkItemSchema>;

export const RunRecordSchema = Type.Object({
  runId: Type.String(),
  owner: Type.String(),
  repo: Type.String(),
  issueNumber: Type.Number({ minimum: 1 }),
  issueUrl: Type.String(),
  issueTitle: Type.String(),
  projectItemId: Type.String(),
  projectId: Type.Optional(Type.String()),
  status: LifecycleStatusSchema,
  paused: Type.Boolean(),
  attempt: Type.Number({ minimum: 1 }),
  branch: Type.String(),
  baseRef: Type.String(),
  worktreePath: Type.String(),
  promptPath: Type.String(),
  launchFlags: Type.Array(Type.String()),
  herdr: HerdrHandlesSchema,
  prNumber: Type.Optional(Type.Number({ minimum: 1 })),
  prUrl: Type.Optional(Type.String()),
  routedFeedbackKeys: Type.Optional(Type.Array(Type.String())),
  lastError: Type.Optional(Type.String()),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

export type RunRecord = Static<typeof RunRecordSchema>;

export const RunEventSchema = Type.Object({
  runId: Type.String(),
  kind: Type.String(),
  payload: Type.Unknown(),
  createdAt: Type.String(),
});

export type RunEvent = Static<typeof RunEventSchema>;

export const WebhookDeliverySchema = Type.Object({
  deliveryId: Type.String(),
  eventName: Type.String(),
  receivedAt: Type.String(),
  status: Type.Optional(
    Type.Union([
      Type.Literal("received"),
      Type.Literal("processing"),
      Type.Literal("processed"),
      Type.Literal("failed"),
    ]),
  ),
  metadata: Type.Record(Type.String(), Type.Unknown()),
  lastError: Type.Optional(Type.String()),
  processedAt: Type.Optional(Type.String()),
  attempts: Type.Optional(Type.Number({ minimum: 0 })),
  nextAttemptAt: Type.Optional(Type.String()),
});

export type WebhookDelivery = Static<typeof WebhookDeliverySchema>;

export const StoreGcOptionsSchema = Type.Object({
  olderThanDays: Type.Optional(Type.Number({ minimum: 1 })),
  vacuum: Type.Optional(Type.Boolean()),
});

export const StoreGcResultSchema = Type.Object({
  deletedEvents: Type.Number({ minimum: 0 }),
  deletedDeliveries: Type.Number({ minimum: 0 }),
  vacuumed: Type.Boolean(),
  walCheckpointed: Type.Boolean(),
});

export type StoreGcOptions = Static<typeof StoreGcOptionsSchema>;
export type StoreGcResult = Static<typeof StoreGcResultSchema>;

export interface ConductorStore {
  init(): Promise<void>;
  createRun(run: RunRecord): Promise<void>;
  updateRun(run: RunRecord): Promise<void>;
  getRun(runId: string): Promise<RunRecord | undefined>;
  listRuns(): Promise<RunRecord[]>;
  getActiveRun(owner: string, repo: string, issueNumber: number): Promise<RunRecord | undefined>;
  appendEvent(event: RunEvent): Promise<void>;
  listEvents(runId: string, limit?: number): Promise<RunEvent[]>;
  recordDelivery(delivery: WebhookDelivery): Promise<boolean>;
  getDelivery(deliveryId: string): Promise<WebhookDelivery | undefined>;
  hasDelivery(deliveryId: string): Promise<boolean>;
  markDeliveryStatus(
    deliveryId: string,
    status: NonNullable<WebhookDelivery["status"]>,
    details?: {
      lastError?: string;
      processedAt?: string;
      attempts?: number;
      nextAttemptAt?: string;
    },
  ): Promise<void>;
  listDeliveriesByStatus(
    status: NonNullable<WebhookDelivery["status"]>,
  ): Promise<WebhookDelivery[]>;
  gc(options?: StoreGcOptions): Promise<StoreGcResult>;
  close?(): void | Promise<void>;
}

export function isActiveLifecycleStatus(status: LifecycleStatus): boolean {
  return status !== "done" && status !== "blocked";
}
