import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PaseoApi } from "@getpaseo/client";

import { formatSystemNote } from "../shared/notice.js";
import {
  DEFAULT_TICKET_PREFIX,
  displayTicketId,
  type ProgressState,
  type Ticket,
} from "../shared/progress.js";
import {
  blockers,
  dueEscalations,
  dueResumeChecks,
  type EscalationLog,
  type EscalationSettings,
  escalationNote,
  type ResumeLog,
  resumeNote,
} from "./escalations.js";
import type { ConductorPaths } from "./paths.js";
import type { ProgressStore } from "./progress-store.js";

export interface ReminderSettings {
  enabled: boolean;
  /** Minutes without an update before a check-in, and between check-ins. */
  minutes: number;
  /** Check-ins per ticket per quiet spell. */
  max: number;
}

export const DEFAULT_REMINDERS: ReminderSettings = {
  enabled: true,
  minutes: 15,
  max: 3,
};

/** Per ticket: the quiet spell it was reminded in (its last update), how often, and when last. */
export type ReminderLog = Record<
  string,
  { since: number; count: number; last: number }
>;

/** When anything last showed work on a ticket: a change, a feed entry, or its agent's ticker. */
export function lastUpdate(state: ProgressState, ticket: Ticket): number {
  return Math.max(
    ...ticket.history.map((change) => Date.parse(change.ts)),
    Date.parse(ticket.updatedAt),
    ...state.activity
      .filter((item) => item.ticket === ticket.id)
      .map((item) => Date.parse(item.ts)),
    state.ticker?.by && ticket.agents.includes(state.ticker.by)
      ? Date.parse(state.ticker.ts)
      : 0,
  );
}

/**
 * Agents to nudge now, each with its quiet working tickets. A ticket is due once it has gone
 * `minutes` without an update, then again every `minutes`, up to `max` times; any update starts
 * a fresh spell. Returns the updated log.
 */
export function dueReminders(
  state: ProgressState,
  now: number,
  log: ReminderLog,
  settings: ReminderSettings,
): { due: Map<string, string[]>; log: ReminderLog } {
  const due = new Map<string, string[]>();
  const next: ReminderLog = {};
  if (!settings.enabled || state.finished) return { due, log: next };
  const wait = settings.minutes * 60_000;
  for (const ticket of state.tickets) {
    if (ticket.status !== "working") continue;
    const owner = ticket.agents.at(-1) ?? ticket.by;
    if (!owner || owner === "user") continue;
    const since = lastUpdate(state, ticket);
    const entry =
      log[ticket.id]?.since === since
        ? log[ticket.id]!
        : { since, count: 0, last: 0 };
    next[ticket.id] = entry;
    if (
      entry.count < settings.max &&
      now - since >= wait &&
      now - entry.last >= wait
    ) {
      next[ticket.id] = { since, count: entry.count + 1, last: now };
      due.set(owner, [...(due.get(owner) ?? []), ticket.id]);
    }
  }
  return { due, log: next };
}

export function reminderNote(
  ticketIds: readonly string[],
  prefix = DEFAULT_TICKET_PREFIX,
): string {
  return `Quick check-in: please update your progress on ${ticketIds.map((id) => displayTicketId(id, prefix)).join(", ")} with the progress tool (stage, percent, a revised estimate if it changed, and a short ticker line).`;
}

export interface MonitorSettings {
  reminders: ReminderSettings;
  escalation: EscalationSettings;
}

/** What escalations.json keeps per conductor. */
interface EscalationState {
  log: EscalationLog;
  resume: ResumeLog;
}

/**
 * Every tick, per conductor: check-ins for quiet working tickets, escalations of long blockers to
 * the conductor, and a nudge to agents seen running again while their ticket is still blocked.
 */
export class ProgressReminders {
  /** Agent statuses at the last tick, to notice an agent starting to run again. */
  private statuses = new Map<string, string>();

  constructor(
    private readonly paths: ConductorPaths,
    private readonly store: ProgressStore,
    private readonly settings: () => Promise<MonitorSettings>,
  ) {}

  private logFile(conductorId: string): string {
    return path.join(this.paths.conductorDir(conductorId), "reminders.json");
  }

  private escalationFile(conductorId: string): string {
    return path.join(this.paths.conductorDir(conductorId), "escalations.json");
  }

  /** How often the conductor was told about each blocker in its current spell. */
  async escalations(conductorId: string): Promise<Record<string, number>> {
    const saved = await this.readEscalations(conductorId);
    return Object.fromEntries(
      Object.entries(saved.log)
        .filter(([, entry]) => entry.count > 0)
        .map(([key, entry]) => [key, entry.count]),
    );
  }

  private readEscalations(conductorId: string): Promise<EscalationState> {
    return readFile(this.escalationFile(conductorId), "utf8")
      .then((raw) => JSON.parse(raw) as EscalationState)
      .catch((): EscalationState => ({ log: {}, resume: {} }));
  }

  private async save(file: string, conductorId: string, value: unknown) {
    await mkdir(this.paths.conductorDir(conductorId), { recursive: true });
    await writeFile(file, JSON.stringify(value));
  }

  async tick(paseo: PaseoApi, now = Date.now()): Promise<void> {
    const { reminders: settings, escalation } = await this.settings();
    const conductors = await readdir(
      path.join(this.paths.root, "conductors"),
    ).catch(() => []);
    const seen = new Map<string, string>();
    const status = async (agentId: string) => {
      if (!seen.has(agentId)) {
        const agent = (
          await paseo.agents
            .ref(agentId)
            .refresh()
            .catch(() => null)
        )?.agent;
        // Archived, closed, or errored agents can't act on a note.
        seen.set(
          agentId,
          !agent || agent.archivedAt ? "gone" : String(agent.status),
        );
      }
      return seen.get(agentId)!;
    };
    const send = async (agentId: string, note: string, what: string) => {
      const current = await status(agentId);
      if (current !== "idle" && current !== "running") return;
      await paseo.agents
        .ref(agentId)
        .send(formatSystemNote(note), { activeTurnBehavior: "steer" })
        .catch((error: unknown) =>
          console.warn(`${what} to ${agentId} failed`, error),
        );
    };
    for (const conductorId of conductors) {
      const state = await this.store.state(conductorId);
      if (!state || state.finished) continue;
      const prefix = await this.store.ticketPrefix(conductorId);

      if (settings.enabled) {
        const log = await readFile(this.logFile(conductorId), "utf8")
          .then((raw) => JSON.parse(raw) as ReminderLog)
          .catch((): ReminderLog => ({}));
        const result = dueReminders(state, now, log, settings);
        for (const [agentId, tickets] of result.due)
          await send(agentId, reminderNote(tickets, prefix), "Check-in");
        if (JSON.stringify(result.log) !== JSON.stringify(log))
          await this.save(this.logFile(conductorId), conductorId, result.log);
      }

      const saved = await this.readEscalations(conductorId);
      const escalated = dueEscalations(state, now, saved.log, escalation);
      if (escalated.due.length)
        await send(
          conductorId,
          escalationNote(escalated.due, now, prefix),
          "Blocker escalation",
        );
      const items = blockers(state);
      const owners = [
        ...new Set(items.flatMap((item) => (item.owner ? [item.owner] : []))),
      ];
      const current = new Map<string, string>();
      for (const owner of owners) current.set(owner, await status(owner));
      const resumed = dueResumeChecks(
        items,
        this.statuses,
        current,
        saved.resume,
      );
      for (const [agentId, mine] of resumed.due)
        await send(agentId, resumeNote(mine, prefix), "Resume check");
      const next: EscalationState = {
        log: escalated.log,
        resume: resumed.log,
      };
      if (JSON.stringify(next) !== JSON.stringify(saved))
        await this.save(this.escalationFile(conductorId), conductorId, next);
    }
    for (const [agentId, value] of seen) this.statuses.set(agentId, value);
  }
}
