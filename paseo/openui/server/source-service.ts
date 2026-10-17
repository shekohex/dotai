import { SourceError, type SourceFailure, specProblems, type SourceSpec } from "../shared/sources";
import { type Library, readSource } from "./library";
import { type SourceRunner, type StreamHub, type StreamRead } from "./sources";

const FIRST_FRAME_MS = 10_000;

export interface CallingAgent {
  id: string;
  /** Where the agent works: commands run here. */
  cwd: string;
  projectRoot?: string;
}

export type CallOutput =
  | { ok: true; mode: "once" | "stream"; data: unknown; streamId?: string; cursor?: number }
  | { ok: false; error: SourceFailure };

export function failureOf(error: unknown): SourceFailure {
  if (error instanceof SourceError) return error.toFailure();
  return { kind: "internal", message: `Unexpected error: ${error instanceof Error ? error.message : String(error)}` };
}

/** Looks up a saved source for an agent and runs it, once or as a shared stream. */
export class SourceService {
  constructor(
    private readonly library: Library,
    private readonly runner: SourceRunner,
    private readonly hub: StreamHub,
  ) {}

  private async resolve(agent: CallingAgent, source: string): Promise<SourceSpec> {
    const snapshot = await this.library.snapshot(agent.projectRoot);
    const named = snapshot.sources.get(source);
    if (!named) {
      const known = [...snapshot.sources.keys()];
      throw new SourceError("unknown-source", `No source named "${source}" is saved for this agent.${known.length ? ` Saved sources: ${known.join(", ")}.` : " None are saved yet."} Define it with render({define: {kind: "source", ...}}).`);
    }
    const spec = readSource(named);
    if (!spec) throw new SourceError("invalid-source", `The saved source "${source}" cannot be read. Define it again with overwrite=true.`);
    const problems = specProblems(spec);
    if (problems.length > 0) throw new SourceError("invalid-source", `The source "${source}" is not usable: ${problems.join(" ")}`);
    return spec;
  }

  async call(agent: CallingAgent, source: string, args: Record<string, unknown>, intent: "query" | "mutation"): Promise<CallOutput> {
    try {
      const spec = await this.resolve(agent, source);
      if (intent === "query" && spec.access === "write") {
        throw new SourceError("forbidden", `"${source}" changes things, so it only runs from a Mutation fired by a button, never from a Query that runs by itself.`);
      }
      const context = { cwd: agent.cwd, name: source };
      if (spec.mode === "once") return { ok: true, mode: "once", data: await this.runner.once(spec, args, context) };
      if (intent === "mutation") throw new SourceError("forbidden", `"${source}" is a stream. Read it with Query; a Mutation runs a source once.`);
      const opened = await this.hub.open(agent.id, spec, args, context);
      const first = await this.hub.firstFrame(opened.id, FIRST_FRAME_MS);
      if (first.state === "failed" || first.state === "gone") {
        this.hub.release(opened.id);
        return { ok: false, error: first.error ?? { kind: "stopped", message: "The stream stopped before it printed anything." } };
      }
      return { ok: true, mode: "stream", data: first.data, streamId: opened.id, cursor: first.cursor };
    } catch (error) {
      return { ok: false, error: failureOf(error) };
    }
  }

  read(streamId: string, cursor: number, waitMs: number): Promise<StreamRead> {
    return this.hub.read(streamId, cursor, waitMs);
  }

  stop(streamId: string): void {
    this.hub.release(streamId);
  }

  close(): void {
    this.hub.close();
  }
}
