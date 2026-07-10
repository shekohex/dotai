import { Value } from "typebox/value";

import {
  type ConductorStore,
  type GitHubSyncState,
  GitHubSyncStateSchema,
  type RunEvent,
  RunEventSchema,
  type RunRecord,
  RunRecordSchema,
  StoreGcOptionsSchema,
  StoreGcResultSchema,
  type StoreGcOptions,
  type StoreGcResult,
  type WebhookDelivery,
  WebhookDeliverySchema,
  isActiveLifecycleStatus,
} from "./types.js";

const DEFAULT_GC_RETENTION_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export class MemoryConductorStore implements ConductorStore {
  private readonly runs = new Map<string, RunRecord>();
  private events: RunEvent[] = [];
  private readonly deliveries = new Map<string, WebhookDelivery>();
  private readonly githubSyncStates = new Map<string, GitHubSyncState>();

  init(): Promise<void> {
    return Promise.resolve();
  }

  async createRun(run: RunRecord): Promise<void> {
    const validated = Value.Parse(RunRecordSchema, run);
    const active = await this.getActiveRun(validated.owner, validated.repo, validated.issueNumber);
    if (active !== undefined && active.runId !== validated.runId) {
      throw new Error(
        `Active run already exists for ${validated.owner}/${validated.repo}#${validated.issueNumber}: ${active.runId}`,
      );
    }
    if (this.runs.has(validated.runId)) throw new Error(`Run already exists: ${validated.runId}`);
    this.runs.set(validated.runId, structuredClone(validated));
  }

  async updateRun(run: RunRecord): Promise<void> {
    const validated = Value.Parse(RunRecordSchema, run);
    if (!this.runs.has(validated.runId)) throw new Error(`Run not found: ${validated.runId}`);
    const active = await this.getActiveRun(validated.owner, validated.repo, validated.issueNumber);
    if (active !== undefined && active.runId !== validated.runId) {
      throw new Error(
        `Active run already exists for ${validated.owner}/${validated.repo}#${validated.issueNumber}: ${active.runId}`,
      );
    }
    this.runs.set(validated.runId, structuredClone(validated));
  }

  getRun(runId: string): Promise<RunRecord | undefined> {
    const run = this.runs.get(runId);
    return Promise.resolve(run === undefined ? undefined : structuredClone(run));
  }

  listRuns(): Promise<RunRecord[]> {
    return Promise.resolve(
      [...this.runs.values()]
        .map((run) => structuredClone(run))
        .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
    );
  }

  getActiveRun(owner: string, repo: string, issueNumber: number): Promise<RunRecord | undefined> {
    const run = [...this.runs.values()].find(
      (entry) =>
        entry.owner === owner &&
        entry.repo === repo &&
        entry.issueNumber === issueNumber &&
        isActiveLifecycleStatus(entry.status),
    );
    return Promise.resolve(run === undefined ? undefined : structuredClone(run));
  }

  appendEvent(event: RunEvent): Promise<void> {
    this.events.push(structuredClone(Value.Parse(RunEventSchema, event)));
    return Promise.resolve();
  }

  listEvents(runId: string, limit = 100): Promise<RunEvent[]> {
    return Promise.resolve(
      this.events
        .filter((event) => event.runId === runId)
        .slice(-limit)
        .map((event) => structuredClone(event)),
    );
  }

  recordDelivery(delivery: WebhookDelivery): Promise<boolean> {
    const validated = Value.Parse(WebhookDeliverySchema, {
      ...delivery,
      status: delivery.status ?? "received",
    });
    if (this.deliveries.has(validated.deliveryId)) return Promise.resolve(false);
    this.deliveries.set(validated.deliveryId, structuredClone(validated));
    return Promise.resolve(true);
  }

  hasDelivery(deliveryId: string): Promise<boolean> {
    return Promise.resolve(this.deliveries.has(deliveryId));
  }

  getDelivery(deliveryId: string): Promise<WebhookDelivery | undefined> {
    const delivery = this.deliveries.get(deliveryId);
    return Promise.resolve(delivery === undefined ? undefined : structuredClone(delivery));
  }

  markDeliveryStatus(
    deliveryId: string,
    status: NonNullable<WebhookDelivery["status"]>,
    details: {
      lastError?: string;
      processedAt?: string;
      attempts?: number;
      nextAttemptAt?: string;
    } = {},
  ): Promise<void> {
    const delivery = this.deliveries.get(deliveryId);
    if (delivery === undefined) throw new Error(`Webhook delivery not found: ${deliveryId}`);
    this.deliveries.set(
      deliveryId,
      Value.Parse(WebhookDeliverySchema, {
        ...delivery,
        status,
        ...details,
      }),
    );
    return Promise.resolve();
  }

  listDeliveriesByStatus(
    status: NonNullable<WebhookDelivery["status"]>,
  ): Promise<WebhookDelivery[]> {
    return Promise.resolve(
      [...this.deliveries.values()]
        .filter((delivery) => delivery.status === status)
        .map((delivery) => structuredClone(delivery)),
    );
  }

  getGitHubSyncState(key: string): Promise<GitHubSyncState | undefined> {
    const state = this.githubSyncStates.get(key);
    return Promise.resolve(state === undefined ? undefined : structuredClone(state));
  }

  setGitHubSyncState(state: GitHubSyncState): Promise<void> {
    const validated = Value.Parse(GitHubSyncStateSchema, state);
    this.githubSyncStates.set(validated.key, structuredClone(validated));
    return Promise.resolve();
  }

  gc(options: StoreGcOptions = {}): Promise<StoreGcResult> {
    const validated = Value.Parse(StoreGcOptionsSchema, options);
    const cutoff = gcCutoffIso(validated.olderThanDays ?? DEFAULT_GC_RETENTION_DAYS);
    const terminalRunIds = new Set(
      [...this.runs.values()]
        .filter((run) => !isActiveLifecycleStatus(run.status) && run.updatedAt < cutoff)
        .map((run) => run.runId),
    );
    const eventsBefore = this.events.length;
    this.events = this.events.filter(
      (event) => !(event.createdAt < cutoff && terminalRunIds.has(event.runId)),
    );
    let deletedDeliveries = 0;
    for (const [deliveryId, delivery] of this.deliveries) {
      if (
        delivery.receivedAt < cutoff &&
        (delivery.status === "processed" || delivery.status === "failed")
      ) {
        this.deliveries.delete(deliveryId);
        deletedDeliveries += 1;
      }
    }
    for (const [key, state] of this.githubSyncStates) {
      if (state.updatedAt < cutoff) this.githubSyncStates.delete(key);
    }
    return Promise.resolve(
      Value.Parse(StoreGcResultSchema, {
        deletedEvents: eventsBefore - this.events.length,
        deletedDeliveries,
        vacuumed: false,
        walCheckpointed: false,
      }),
    );
  }
}

function gcCutoffIso(olderThanDays: number): string {
  return new Date(Date.now() - olderThanDays * MS_PER_DAY).toISOString();
}
