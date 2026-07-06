import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { parseJsonValue } from "../json.js";
import {
  type ConductorStore,
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
} from "./types.js";

const DEFAULT_GC_RETENTION_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const RunRowSchema = Type.Object({
  payload_json: Type.String(),
});

const EventRowSchema = Type.Object({
  payload_json: Type.String(),
});

const CountRowSchema = Type.Object({
  count: Type.Number(),
});

export class SqliteConductorStore implements ConductorStore {
  private db: DatabaseSync | undefined;

  constructor(private readonly dbPath: string) {}

  async init(): Promise<void> {
    await mkdir(dirname(this.dbPath), { recursive: true });
    const db = this.getDatabase();
    this.applyRuntimePragmas();
    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        status TEXT NOT NULL,
        paused INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS runs_active_item_idx
        ON runs(owner, repo, issue_number)
        WHERE status NOT IN ('done', 'blocked');
      CREATE TABLE IF NOT EXISTS run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS run_events_run_id_idx ON run_events(run_id, id);
      CREATE INDEX IF NOT EXISTS run_events_created_at_idx ON run_events(created_at);
      CREATE TABLE IF NOT EXISTS github_deliveries (
        delivery_id TEXT PRIMARY KEY,
        event_name TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'received',
        received_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS github_deliveries_status_idx ON github_deliveries(status, received_at);
    `);
    this.migrateDeliveryStatusColumn();
    this.optimize();
  }

  createRun(run: RunRecord): Promise<void> {
    const validated = Value.Parse(RunRecordSchema, run);
    this.getDatabase()
      .prepare(
        `INSERT INTO runs
          (run_id, owner, repo, issue_number, status, paused, payload_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        validated.runId,
        validated.owner,
        validated.repo,
        validated.issueNumber,
        validated.status,
        validated.paused ? 1 : 0,
        JSON.stringify(validated),
        validated.createdAt,
        validated.updatedAt,
      );
    return Promise.resolve();
  }

  updateRun(run: RunRecord): Promise<void> {
    const validated = Value.Parse(RunRecordSchema, run);
    const result = this.getDatabase()
      .prepare(
        `UPDATE runs
          SET status = ?, paused = ?, payload_json = ?, updated_at = ?
          WHERE run_id = ?`,
      )
      .run(
        validated.status,
        validated.paused ? 1 : 0,
        JSON.stringify(validated),
        validated.updatedAt,
        validated.runId,
      );
    if (result.changes === 0) throw new Error(`Run not found: ${validated.runId}`);
    return Promise.resolve();
  }

  getRun(runId: string): Promise<RunRecord | undefined> {
    const row = this.getDatabase()
      .prepare("SELECT payload_json FROM runs WHERE run_id = ?")
      .get(runId);
    return Promise.resolve(row === undefined ? undefined : parseRunRow(row, "run row"));
  }

  listRuns(): Promise<RunRecord[]> {
    return Promise.resolve(
      this.getDatabase()
        .prepare("SELECT payload_json FROM runs ORDER BY created_at ASC")
        .all()
        .map((row) => parseRunRow(row, "run row")),
    );
  }

  getActiveRun(owner: string, repo: string, issueNumber: number): Promise<RunRecord | undefined> {
    const row = this.getDatabase()
      .prepare(
        `SELECT payload_json FROM runs
         WHERE owner = ? AND repo = ? AND issue_number = ? AND status NOT IN ('done', 'blocked')
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get(owner, repo, issueNumber);
    return Promise.resolve(row === undefined ? undefined : parseRunRow(row, "active run row"));
  }

  appendEvent(event: RunEvent): Promise<void> {
    const validated = Value.Parse(RunEventSchema, event);
    this.getDatabase()
      .prepare(
        `INSERT INTO run_events (run_id, kind, payload_json, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(validated.runId, validated.kind, JSON.stringify(validated), validated.createdAt);
    return Promise.resolve();
  }

  listEvents(runId: string, limit = 100): Promise<RunEvent[]> {
    return Promise.resolve(
      this.getDatabase()
        .prepare(
          `SELECT payload_json FROM run_events
         WHERE run_id = ? ORDER BY id DESC LIMIT ?`,
        )
        .all(runId, limit)
        .map((row) => parseEventRow(row, "event row"))
        .toReversed(),
    );
  }

  recordDelivery(delivery: WebhookDelivery): Promise<boolean> {
    const validated = Value.Parse(WebhookDeliverySchema, {
      ...delivery,
      status: delivery.status ?? "received",
    });
    const result = this.getDatabase()
      .prepare(
        `INSERT OR IGNORE INTO github_deliveries
          (delivery_id, event_name, payload_json, status, received_at)
          VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        validated.deliveryId,
        validated.eventName,
        JSON.stringify(validated),
        validated.status ?? "received",
        validated.receivedAt,
      );
    return Promise.resolve(result.changes > 0);
  }

  hasDelivery(deliveryId: string): Promise<boolean> {
    const row = this.getDatabase()
      .prepare("SELECT COUNT(*) AS count FROM github_deliveries WHERE delivery_id = ?")
      .get(deliveryId);
    return Promise.resolve(Value.Parse(CountRowSchema, row).count > 0);
  }

  getDelivery(deliveryId: string): Promise<WebhookDelivery | undefined> {
    const row = this.getDatabase()
      .prepare("SELECT payload_json FROM github_deliveries WHERE delivery_id = ?")
      .get(deliveryId);
    return Promise.resolve(
      row === undefined
        ? undefined
        : Value.Parse(
            WebhookDeliverySchema,
            parseJsonValue(Value.Parse(RunRowSchema, row).payload_json, "webhook delivery row"),
          ),
    );
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
    const row = this.getDatabase()
      .prepare("SELECT payload_json FROM github_deliveries WHERE delivery_id = ?")
      .get(deliveryId);
    if (row === undefined) throw new Error(`Webhook delivery not found: ${deliveryId}`);
    const delivery = Value.Parse(
      WebhookDeliverySchema,
      parseJsonValue(Value.Parse(RunRowSchema, row).payload_json, "webhook delivery row"),
    );
    const updated = Value.Parse(WebhookDeliverySchema, {
      ...delivery,
      status,
      ...details,
    });
    this.getDatabase()
      .prepare("UPDATE github_deliveries SET status = ?, payload_json = ? WHERE delivery_id = ?")
      .run(status, JSON.stringify(updated), deliveryId);
    return Promise.resolve();
  }

  listDeliveriesByStatus(
    status: NonNullable<WebhookDelivery["status"]>,
  ): Promise<WebhookDelivery[]> {
    return Promise.resolve(
      this.getDatabase()
        .prepare(
          "SELECT payload_json FROM github_deliveries WHERE status = ? ORDER BY received_at ASC",
        )
        .all(status)
        .map((row) =>
          Value.Parse(
            WebhookDeliverySchema,
            parseJsonValue(Value.Parse(RunRowSchema, row).payload_json, "webhook delivery row"),
          ),
        ),
    );
  }

  gc(options: StoreGcOptions = {}): Promise<StoreGcResult> {
    const validated = Value.Parse(StoreGcOptionsSchema, options);
    const cutoff = gcCutoffIso(validated.olderThanDays ?? DEFAULT_GC_RETENTION_DAYS);
    const db = this.getDatabase();
    const deletedEvents = db
      .prepare(
        `DELETE FROM run_events
         WHERE created_at < ?
           AND run_id IN (
             SELECT run_id FROM runs
             WHERE status IN ('done', 'blocked') AND updated_at < ?
           )`,
      )
      .run(cutoff, cutoff).changes;
    const deletedDeliveries = db
      .prepare(
        `DELETE FROM github_deliveries
         WHERE received_at < ? AND status IN ('processed', 'failed')`,
      )
      .run(cutoff).changes;
    this.optimize();
    this.checkpointWal();
    const vacuumed = validated.vacuum ?? true;
    if (vacuumed) db.exec("VACUUM");
    return Promise.resolve(
      Value.Parse(StoreGcResultSchema, {
        deletedEvents,
        deletedDeliveries,
        vacuumed,
        walCheckpointed: true,
      }),
    );
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  private getDatabase(): DatabaseSync {
    this.db ??= new DatabaseSync(this.dbPath);
    return this.db;
  }

  private applyRuntimePragmas(): void {
    this.getDatabase().exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA temp_store = MEMORY;
      PRAGMA wal_autocheckpoint = 1000;
    `);
  }

  private optimize(): void {
    this.getDatabase().exec("PRAGMA optimize");
  }

  private checkpointWal(): void {
    this.getDatabase().exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  private migrateDeliveryStatusColumn(): void {
    try {
      this.getDatabase().prepare("SELECT status FROM github_deliveries LIMIT 1").get();
    } catch {
      this.getDatabase().exec(
        "ALTER TABLE github_deliveries ADD COLUMN status TEXT NOT NULL DEFAULT 'received'",
      );
    }
  }
}

function gcCutoffIso(olderThanDays: number): string {
  return new Date(Date.now() - olderThanDays * MS_PER_DAY).toISOString();
}

function parseRunRow(row: unknown, label: string): RunRecord {
  const parsedRow = Value.Parse(RunRowSchema, row);
  return Value.Parse(RunRecordSchema, parseJsonValue(parsedRow.payload_json, label));
}

function parseEventRow(row: unknown, label: string): RunEvent {
  const parsedRow = Value.Parse(EventRowSchema, row);
  return Value.Parse(RunEventSchema, parseJsonValue(parsedRow.payload_json, label));
}
