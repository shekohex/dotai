import { describe, expect, it } from "vitest";
import type { SourceCallResult, SourceReadResult } from "../shared/sources";
import { createSourceProvider, type SourceDeps } from "./sources";

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

function harness(overrides: Partial<SourceDeps> = {}) {
  const log = { calls: [] as unknown[], stops: [] as string[], changes: [] as string[], results: 0 };
  const queues = { call: [] as (SourceCallResult | Error)[], read: [] as (SourceReadResult | Error | Promise<SourceReadResult>)[] };
  const deps: SourceDeps = {
    agentId: "a1",
    call: async (input) => {
      log.calls.push(input);
      const next = queues.call.shift();
      if (next instanceof Error) throw next;
      return next ?? { ok: true, mode: "once", data: null };
    },
    read: async () => {
      const next = queues.read.shift();
      if (next instanceof Error) throw next;
      if (next) return next;
      await tick(30);
      return { cursor: 0, state: "running", changed: false, data: null };
    },
    stop: async ({ streamId }) => {
      log.stops.push(streamId);
    },
    intent: () => "query",
    onChange: (name) => log.changes.push(name),
    onResult: () => {
      log.results++;
    },
    retry: { baseMs: 5, maxMs: 20, attempts: 3 },
    holdMs: 50,
    ...overrides,
  };
  return { provider: createSourceProvider(deps), log, queues };
}

const streamOpen = (data: unknown, id = "s1", cursor = 1): SourceCallResult => ({ ok: true, mode: "stream", data, streamId: id, cursor });
const frame = (data: unknown, cursor: number): SourceReadResult => ({ cursor, state: "running", changed: true, data });

describe("once sources", () => {
  it("returns the data and sends the agent, source, args and intent", async () => {
    const { provider, log, queues } = harness({ intent: (name) => (name === "deploy" ? "mutation" : "query") });
    queues.call.push({ ok: true, mode: "once", data: { cpu: 3 } }, { ok: true, mode: "once", data: { ok: true } });
    expect(await provider.callTool("stats", { host: "a" })).toEqual({ cpu: 3 });
    expect(await provider.callTool("deploy", {})).toEqual({ ok: true });
    expect(log.calls).toEqual([
      { agentId: "a1", source: "stats", args: { host: "a" }, intent: "query" },
      { agentId: "a1", source: "deploy", args: {}, intent: "mutation" },
    ]);
  });

  it("throws the daemon's failure with its kind and detail", async () => {
    const { provider, queues } = harness();
    queues.call.push({ ok: false, error: { kind: "exit", message: "The command failed (exit code 2).", detail: "stderr: boom" } });
    const error = await provider.callTool("stats", {}).catch((caught: unknown) => caught as Error & { kind: string });
    expect(error).toMatchObject({ kind: "exit" });
    expect((error as Error).message).toBe("The command failed (exit code 2). (stderr: boom)");
  });

  it("explains an unreachable daemon", async () => {
    const { provider, queues } = harness();
    queues.call.push(new Error("socket closed"));
    await expect(provider.callTool("stats", {})).rejects.toThrow(/Could not reach the daemon to run "stats": socket closed/);
  });

  it("answers from the last value while the app is in the background", async () => {
    const { provider, log, queues } = harness();
    queues.call.push({ ok: true, mode: "once", data: 1 });
    await provider.callTool("stats", {});
    provider.setActive(false);
    expect(await provider.callTool("stats", {})).toBe(1);
    expect(log.calls).toHaveLength(1);
    provider.setActive(true);
    queues.call.push({ ok: true, mode: "once", data: 2 });
    expect(await provider.callTool("stats", {})).toBe(2);
  });
});

describe("stream sources", () => {
  it("returns the first frame, then tells the queries about each change", async () => {
    const { provider, log, queues } = harness();
    queues.call.push(streamOpen({ n: 1 }));
    queues.read.push(frame({ n: 2 }, 2), frame({ n: 3 }, 3));
    expect(await provider.callTool("ticks", {})).toEqual({ n: 1 });
    await tick(20);
    expect(log.changes.filter((name) => name === "ticks").length).toBeGreaterThanOrEqual(2);
    expect(await provider.callTool("ticks", {})).toEqual({ n: 3 });
    expect(log.calls).toHaveLength(1);
    provider.shutdown();
    expect(log.stops).toEqual(["s1"]);
  });

  it("stops listening when the stream ends and keeps the last value", async () => {
    const { provider, log, queues } = harness();
    queues.call.push(streamOpen(1));
    queues.read.push({ cursor: 2, state: "ended", changed: true, data: 9 });
    await provider.callTool("ticks", {});
    await tick(20);
    expect(await provider.callTool("ticks", {})).toBe(9);
    expect(log.calls).toHaveLength(1);
    provider.shutdown();
  });

  it("surfaces a failure, reconnects after a backoff and carries on", async () => {
    const { provider, log, queues } = harness();
    queues.call.push(streamOpen(1, "s1"), streamOpen(5, "s2", 1));
    queues.read.push({ cursor: 1, state: "failed", changed: false, data: null, error: { kind: "exit", message: "The command stopped (exit code 1)." } });
    await provider.callTool("ticks", {});
    await tick(2);
    await expect(provider.callTool("ticks", {})).rejects.toThrow(/exit code 1/);
    await tick(60);
    expect(await provider.callTool("ticks", {})).toBe(5);
    expect(log.calls).toHaveLength(2);
    provider.shutdown();
  });

  it("treats a lost connection like a failure and retries", async () => {
    const { provider, queues } = harness();
    queues.call.push(streamOpen(1), streamOpen(7, "s2"));
    queues.read.push(new Error("offline"));
    await provider.callTool("ticks", {});
    await tick(60);
    expect(await provider.callTool("ticks", {})).toBe(7);
    provider.shutdown();
  });

  it("gives up after the allowed attempts and restarts on a manual call", async () => {
    const { provider, log, queues } = harness();
    queues.call.push(
      streamOpen(1),
      { ok: false, error: { kind: "network", message: "refused" } },
      { ok: false, error: { kind: "network", message: "refused" } },
    );
    queues.read.push({ cursor: 1, state: "gone", changed: false, data: null });
    await provider.callTool("ticks", {});
    await tick(120);
    await expect(provider.callTool("ticks", {})).rejects.toThrow(/Gave up after 3 tries/);
    const callsBefore = log.calls.length;
    await tick(60);
    expect(log.calls.length).toBe(callsBefore);
    queues.call.push(streamOpen(42, "s9"));
    await provider.retry();
    expect(await provider.callTool("ticks", {})).toBe(42);
    provider.shutdown();
  });

  it("closes streams in the background and reopens them on return", async () => {
    const { provider, log, queues } = harness();
    queues.call.push(streamOpen({ v: 1 }, "s1"), streamOpen({ v: 2 }, "s2"));
    await provider.callTool("ticks", {});
    provider.setActive(false);
    expect(log.stops).toEqual(["s1"]);
    expect(await provider.callTool("ticks", {})).toEqual({ v: 1 });
    provider.setActive(true);
    await tick(20);
    expect(await provider.callTool("ticks", {})).toEqual({ v: 2 });
    expect(log.changes).toContain("ticks");
    provider.shutdown();
  });

  it("passes a failed first call straight through", async () => {
    const { provider, queues } = harness();
    queues.call.push({ ok: false, error: { kind: "timeout", message: "The stream printed nothing for 30s and was stopped." } });
    await expect(provider.callTool("ticks", {})).rejects.toThrow(/printed nothing/);
  });

  it("keeps separate streams for separate args", async () => {
    const { provider, log, queues } = harness();
    queues.call.push(streamOpen("a", "s1"), streamOpen("b", "s2"));
    expect(await provider.callTool("ticks", { x: 1 })).toBe("a");
    expect(await provider.callTool("ticks", { x: 2 })).toBe("b");
    expect(await provider.callTool("ticks", { x: 1 })).toBe("a");
    expect(log.calls).toHaveLength(2);
    provider.shutdown();
    expect(log.stops.sort()).toEqual(["s1", "s2"]);
  });
});
