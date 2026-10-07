import type { PaseoAgentListResult, PaseoApi } from "@getpaseo/client";

import { conductorLabels, PARENT_AGENT_LABEL } from "../shared/labels.js";
import { formatConductorNotice } from "../shared/notice.js";
import {
  evaluateWorkers,
  type PlannedNotice,
  type WorkerObservation,
  type WorkerRecords,
} from "./health.js";
import type { LedgerStore } from "./ledger.js";

type AgentSnapshot = PaseoAgentListResult["entries"][number]["agent"];

async function listActiveAgents(
  paseo: PaseoApi,
  labels: Record<string, string>,
): Promise<AgentSnapshot[]> {
  const result = await paseo.agents.list({
    filter: { labels },
    page: { limit: 200 },
  });
  return result.entries
    .map((entry) => entry.agent)
    .filter((agent) => !agent.archivedAt);
}

function toObservation(
  worker: AgentSnapshot,
  conductorId: string,
): WorkerObservation {
  return {
    id: worker.id,
    conductorId,
    title: worker.title ?? worker.id,
    status: worker.status,
    updatedAt: worker.updatedAt,
    pendingPermissionIds: worker.pendingPermissions.map(
      (request) => request.id,
    ),
  };
}

async function deliver(paseo: PaseoApi, notice: PlannedNotice): Promise<void> {
  const text = formatConductorNotice({
    agentId: notice.workerId,
    title: notice.title,
    reason: notice.reason,
    detail: notice.detail,
  });
  await paseo.agents
    .ref(notice.conductorId)
    .send(text, { messageId: notice.messageId, activeTurnBehavior: "steer" });
}

/** Keeps a durable worker ledger and sends notices Paseo's own notify-on-finish cannot. */
export class ConductorMonitor {
  private paseo: PaseoApi | undefined;
  private records: WorkerRecords | undefined;
  private startupPending = true;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly ledger: LedgerStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** Plugin servers only receive the Paseo API through hook and RPC contexts. */
  attach(paseo: PaseoApi): void {
    if (this.paseo) return;
    this.paseo = paseo;
    void this.refresh();
  }

  refresh(): Promise<void> {
    this.queue = this.queue
      .then(() => this.reconcile())
      .catch((error: unknown) =>
        console.warn("Conductor reconcile failed", error),
      );
    return this.queue;
  }

  private async reconcile(): Promise<void> {
    const paseo = this.paseo;
    if (!paseo) return;
    this.records ??= await this.ledger.load();

    const observations: WorkerObservation[] = [];
    for (const conductor of await listActiveAgents(paseo, conductorLabels)) {
      const workers = await listActiveAgents(paseo, {
        [PARENT_AGENT_LABEL]: conductor.id,
      });
      observations.push(
        ...workers.map((worker) => toObservation(worker, conductor.id)),
      );
    }

    const result = evaluateWorkers({
      records: this.records,
      observations,
      now: this.now(),
      startup: this.startupPending,
    });
    this.startupPending = false;
    this.records = result.records;
    await this.ledger.save(result.records);

    for (const notice of result.notices) {
      await deliver(paseo, notice).catch((error: unknown) =>
        console.warn(
          "Conductor notice delivery failed",
          notice.messageId,
          error,
        ),
      );
    }
  }
}
