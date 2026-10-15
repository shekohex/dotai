import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { checkLinks } from "../shared/links.js";
import { progressGuide } from "../shared/progress-guide.js";
import {
  type DashboardView,
  dashboardViewSchema,
  DEFAULT_TICKET_PREFIX,
  displayTicketId,
  nextId,
  normalizeChoice,
  normalizeId,
  parseTicketId,
  type ProgressEvent,
  type ProgressInput,
  type ProgressState,
  reduceProgress,
  renderForAgent,
  summarize,
} from "../shared/progress.js";
import type { ConductorPaths } from "./paths.js";

export class ProgressError extends Error {}

/** Per-conductor settings kept beside its progress log. */
interface ConductorMeta {
  ticketPrefix?: string;
  view?: unknown;
}

function parseLines(raw: string): ProgressEvent[] {
  const events: ProgressEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as ProgressEvent;
      if (parsed.v === 1 && parsed.op) events.push(parsed);
    } catch {
      // A half-written or damaged line must not hide the rest of the run.
    }
  }
  return events;
}

/** Append-only progress log next to a conductor's notes, serialized per conductor. */
export class ProgressStore {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly paths: ConductorPaths,
    private readonly now: () => Date = () => new Date(),
    /** Called after every appended event, e.g. to mirror the run into the repo. */
    private readonly onRecorded?: (
      conductorId: string,
      event: ProgressEvent,
    ) => Promise<void>,
  ) {}

  private file(conductorId: string): string {
    return path.join(this.paths.conductorDir(conductorId), "progress.jsonl");
  }

  async events(conductorId: string): Promise<ProgressEvent[]> {
    const raw = await readFile(this.file(conductorId), "utf8").catch(() => "");
    return parseLines(raw);
  }

  /** Events of the current run: from the last `start` onward. */
  async currentRun(conductorId: string): Promise<ProgressEvent[]> {
    const events = await this.events(conductorId);
    const startIndex = events.map((event) => event.op).lastIndexOf("start");
    return startIndex < 0 ? events : events.slice(startIndex);
  }

  async state(conductorId: string): Promise<ProgressState | null> {
    return reduceProgress(await this.events(conductorId));
  }

  /** Validates `input` against the current run, appends it, and returns the agent-facing reply. */
  record(
    conductorId: string,
    input: ProgressInput,
    by?: string,
  ): Promise<string> {
    const previous = this.queues.get(conductorId) ?? Promise.resolve();
    const run = previous.then(() => this.recordNow(conductorId, input, by));
    this.queues.set(
      conductorId,
      run.catch(() => undefined),
    );
    return run;
  }

  private metaFile(conductorId: string): string {
    return path.join(this.paths.conductorDir(conductorId), "meta.json");
  }

  private async meta(conductorId: string): Promise<ConductorMeta> {
    return readFile(this.metaFile(conductorId), "utf8")
      .then((raw) => JSON.parse(raw) as ConductorMeta)
      .catch((): ConductorMeta => ({}));
  }

  private async updateMeta(
    conductorId: string,
    change: Partial<ConductorMeta>,
  ): Promise<void> {
    const next = { ...(await this.meta(conductorId)), ...change };
    await mkdir(this.paths.conductorDir(conductorId), { recursive: true });
    await writeFile(this.metaFile(conductorId), JSON.stringify(next));
  }

  /** How this conductor's ticket ids read (AI for AI-01); stored ids stay T01. */
  async ticketPrefix(conductorId: string): Promise<string> {
    return (await this.meta(conductorId)).ticketPrefix ?? DEFAULT_TICKET_PREFIX;
  }

  /** Expects a prefix already checked with ticketPrefixSchema. */
  async setTicketPrefix(conductorId: string, prefix: string): Promise<void> {
    await this.updateMeta(conductorId, { ticketPrefix: prefix });
  }

  /** The dashboard's saved search and sort, so they survive reloads and devices. */
  async view(conductorId: string): Promise<DashboardView> {
    const saved = dashboardViewSchema.safeParse(
      (await this.meta(conductorId)).view ?? {},
    );
    return saved.success ? saved.data : dashboardViewSchema.parse({});
  }

  async setView(conductorId: string, view: DashboardView): Promise<void> {
    await this.updateMeta(conductorId, { view });
  }

  private async recordNow(
    conductorId: string,
    raw: ProgressInput,
    by?: string,
  ): Promise<string> {
    const events = await this.events(conductorId);
    const state = reduceProgress(events);
    const prefix = await this.ticketPrefix(conductorId);
    // Agents write tickets as people see them (AI-03) or by number; they are stored as T03.
    const resolve = (ref: string) => parseTicketId(ref, prefix) ?? ref;
    const input = {
      ...raw,
      ...(raw.op === "ticket" && raw.id ? { id: resolve(raw.id) } : {}),
      ...(raw.ticket ? { ticket: resolve(raw.ticket) } : {}),
      ...(raw.waitsFor ? { waitsFor: raw.waitsFor.map(resolve) } : {}),
      ...(raw.related ? { related: raw.related.map(resolve) } : {}),
      ...(raw.parent ? { parent: resolve(raw.parent) } : {}),
    };
    if (input.op === "show")
      return renderForAgent(state, this.now().getTime(), prefix);
    if (input.op === "help")
      return progressGuide(this.paths.templatesDir, prefix);
    const show = (id: string) => displayTicketId(id, prefix);

    const taken = events.flatMap((event) => (event.id ? [event.id] : []));
    const { op: _op, ...fields } = input;
    const event: ProgressEvent = {
      ...fields,
      v: 1,
      ts: this.now().toISOString(),
      ...(by ? { by } : {}),
      op: input.op,
    };
    const ticketRef = input.ticket ? normalizeId(input.ticket) : undefined;
    if (ticketRef) event.ticket = ticketRef;
    let reply: string;

    switch (input.op) {
      case "start":
        if (!input.title?.trim()) throw new ProgressError("start needs title");
        reply = `Started "${input.title.trim()}"`;
        break;
      case "ticket": {
        const known = normalizeId(input.id);
        if (input.id && !known)
          throw new ProgressError(`Bad ticket id ${raw.id}`);
        if (known && !state?.tickets.some((ticket) => ticket.id === known)) {
          if (!input.title?.trim())
            throw new ProgressError(
              `Unknown ticket ${show(known)}; give title to add it`,
            );
        }
        if (!known && !input.title?.trim()) {
          throw new ProgressError("ticket needs id to update or title to add");
        }
        if (state?.finished)
          throw new ProgressError("Run is finished; call start for a new one");
        event.id = known ?? nextId("T", taken);
        const linkError = checkLinks(
          state,
          event.id,
          {
            ...(input.waitsFor ? { waitsFor: input.waitsFor } : {}),
            ...(input.parent ? { parent: input.parent } : {}),
            ...(input.related ? { related: input.related } : {}),
          },
          show,
        );
        if (linkError) throw new ProgressError(linkError);
        reply = `${show(event.id)} ${input.status ?? (known ? "updated" : "added")}`;
        break;
      }
      case "ask": {
        if (!input.title?.trim() || !input.text?.trim())
          throw new ProgressError("ask needs title and text");
        if (!input.options || input.options.length < 2)
          throw new ProgressError("ask needs 2+ options");
        const recommend = normalizeChoice(
          { options: input.options, multi: input.multi },
          input.recommend,
        );
        if (!recommend) {
          throw new ProgressError(
            input.multi
              ? "ask needs recommend set to option keys, like A or A,C"
              : "ask needs recommend set to one option key",
          );
        }
        event.recommend = recommend;
        event.id = nextId("Q", taken);
        reply = `Asked ${event.id}. Build nothing it affects until answered; work on other things`;
        break;
      }
      case "answer": {
        const question = state?.questions.find(
          (candidate) => candidate.id === normalizeId(input.id),
        );
        if (!question || (!input.choice && !input.words?.trim()))
          throw new ProgressError(
            "answer needs a known id and a choice or words",
          );
        if (input.choice) {
          const choice = normalizeChoice(question, input.choice);
          if (!choice)
            throw new ProgressError(
              `Bad choice for ${question.id}; use ${question.multi ? "option keys like A,C" : "one option key"}`,
            );
          event.choice = choice;
        }
        event.id = question.id;
        reply = `Answered ${question.id}`;
        break;
      }
      case "withdraw": {
        const question = state?.questions.find(
          (candidate) => candidate.id === normalizeId(input.id),
        );
        if (!question)
          throw new ProgressError("withdraw needs a known question id");
        event.id = question.id;
        reply = `Withdrew ${question.id}`;
        break;
      }
      case "deliver":
        if (!input.target) throw new ProgressError("deliver needs target");
        event.id = nextId("D", taken);
        reply = `Added ${event.id}`;
        break;
      case "stuck":
        if (!input.text?.trim()) throw new ProgressError("stuck needs text");
        event.id = nextId("S", taken);
        reply = `Flagged ${event.id}`;
        break;
      case "unstuck": {
        const flag = state?.stuck.find(
          (candidate) => candidate.id === normalizeId(input.id),
        );
        if (!flag) throw new ProgressError("unstuck needs a known stuck id");
        event.id = flag.id;
        reply = `Cleared ${flag.id}`;
        break;
      }
      case "ticker":
        if (!input.text?.trim()) throw new ProgressError("ticker needs text");
        reply = "ok";
        break;
      case "finish": {
        if (!state) throw new ProgressError("Nothing to finish");
        const summary = summarize(state);
        const open =
          state.tickets.length -
          summary.done -
          state.tickets.filter((ticket) => ticket.status === "skipped").length;
        if (open > 0 || summary.openQuestions > 0 || summary.openStuck > 0) {
          throw new ProgressError(
            `Cannot finish: ${open} tickets open, ${summary.openQuestions} questions open, ${summary.openStuck} stuck`,
          );
        }
        if (!input.title?.trim())
          throw new ProgressError("finish needs title (the outcome)");
        reply = "Finished";
        break;
      }
    }

    await mkdir(this.paths.conductorDir(conductorId), { recursive: true });
    await appendFile(this.file(conductorId), `${JSON.stringify(event)}\n`);
    void this.onRecorded?.(conductorId, event).catch((error: unknown) =>
      console.warn("Progress follow-up failed", error),
    );
    return reply;
  }
}
