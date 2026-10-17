import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SourceError, type SourceFailure, type SourceSpec, withDefaults } from "../shared/sources";
import { SourceRunner, StreamHub } from "./sources";

const command = (run: string, extra: Partial<SourceSpec> = {}): SourceSpec => withDefaults({ type: "command", run, ...extra });
let cwd = "";
const context = () => ({ cwd, name: "probe" });
const kind = async (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => "ok",
    (error: unknown) => (error instanceof SourceError ? error.kind : `other:${String(error)}`),
  );

beforeAll(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "openui-src-"));
});

describe("command sources, once", () => {
  it("returns the JSON on stdout and hands the args over on stdin and env", async () => {
    const runner = new SourceRunner();
    const via = await runner.once(command('cat | tr -d "\\n"'), { host: "a" }, context());
    expect(via).toEqual({ args: { host: "a" } });
    const env = await runner.once(command('printf "%s" "$OPENUI_ARGS"'), { n: 2 }, context());
    expect(env).toEqual({ n: 2 });
    expect(await runner.once(command('printf "%s" "$OPENUI_SOURCE"'.replace("%s", '\\"%s\\"')), {}, context())).toBe("probe");
  });

  it("never lets an argument reach the command line", async () => {
    const runner = new SourceRunner();
    const marker = path.join(cwd, "pwned");
    const value = await runner.once(command("cat"), { name: `"; touch ${marker}; "` }, context());
    expect(JSON.stringify(value)).toContain("touch");
    await expect(runner.once(command(`test -e ${marker} && echo '{"hit":true}' || echo '{"hit":false}'`), {}, context())).resolves.toEqual({ hit: false });
  });

  it("runs in the agent's directory, or the one the source names", async () => {
    const runner = new SourceRunner();
    expect(await runner.once(command('printf "\\"%s\\"" "$(pwd -P)"'), {}, context())).toBe(await import("node:fs/promises").then((fs) => fs.realpath(cwd)));
    expect(await kind(runner.once(command("echo 1", { cwd: "missing" }), {}, context()))).toBe("spawn");
  });

  it("explains a failing command with its exit code and stderr", async () => {
    const runner = new SourceRunner();
    const error = await runner.once(command("echo boom >&2; exit 3"), {}, context()).catch((caught: unknown) => caught as SourceError);
    expect(error).toMatchObject({ kind: "exit" });
    expect((error as SourceError).message).toContain("exit code 3");
    expect((error as SourceError).detail).toContain("boom");
  });

  it("stops a command that outlives its timeout, and tells the agent how to raise it", async () => {
    const runner = new SourceRunner();
    const started = Date.now();
    const error = await runner.once(command("sleep 30", { timeoutSeconds: 0.3 }), {}, context()).catch((caught: unknown) => caught as SourceError);
    expect(error).toMatchObject({ kind: "timeout" });
    expect((error as SourceError).message).toContain("timeoutSeconds");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(runner.active).toBe(0);
  });

  it("kills the whole process tree on timeout", async () => {
    const runner = new SourceRunner();
    const pidFile = path.join(cwd, "child.pid");
    await runner.once(command(`(sleep 30 & echo $! > ${pidFile}; wait)`, { timeoutSeconds: 0.4 }), {}, context()).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const pid = Number((await import("node:fs/promises").then((fs) => fs.readFile(pidFile, "utf8"))).trim());
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("reports output that is not JSON, empty or too large", async () => {
    const runner = new SourceRunner();
    expect(await kind(runner.once(command("echo hello"), {}, context()))).toBe("parse");
    expect(await kind(runner.once(command("true"), {}, context()))).toBe("parse");
    expect(await kind(runner.once(command("head -c 1500000 /dev/zero | tr '\\0' 'x'"), {}, context()))).toBe("output");
  });

  it("unwraps JSON-RPC and surfaces its errors", async () => {
    const runner = new SourceRunner();
    expect(await runner.once(command(`echo '{"jsonrpc":"2.0","id":1,"result":{"cpu":5}}'`), {}, context())).toEqual({ cpu: 5 });
    expect(await kind(runner.once(command(`echo '{"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"down"}}'`), {}, context()))).toBe("rpc");
  });

  it("reads the last line of NDJSON output", async () => {
    const runner = new SourceRunner();
    expect(await runner.once(command(`printf '{"n":1}\\n{"n":2}\\n'`), {}, context())).toEqual({ n: 2 });
  });

  it("refuses oversized arguments and a crowd of processes", async () => {
    const runner = new SourceRunner(2);
    expect(await kind(runner.once(command("cat"), { big: "x".repeat(70_000) }, context()))).toBe("bad-args");
    const slow = [1, 2].map(() => runner.once(command("sleep 0.5; echo 1"), {}, context()));
    expect(await kind(runner.once(command("echo 1"), {}, context()))).toBe("busy");
    await Promise.all(slow);
  });

  it("reports a command that does not exist", async () => {
    const runner = new SourceRunner();
    expect(await kind(runner.once(command("definitely-not-a-command-xyz"), {}, context()))).toBe("exit");
  });
});

interface Collected {
  frames: unknown[];
  ended: boolean;
  failure?: SourceFailure;
}

async function collect(runner: SourceRunner, spec: SourceSpec, args: Record<string, unknown> = {}, ms = 600) {
  const seen: Collected = { frames: [], ended: false };
  const channel = await runner.stream(spec, args, context(), {
    frame: (value) => seen.frames.push(value),
    end: (failure) => {
      seen.ended = true;
      if (failure) seen.failure = failure;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, ms));
  return { seen, channel };
}

describe("command sources, streaming", () => {
  it("delivers each JSON line as a frame and ends cleanly with the process", async () => {
    const runner = new SourceRunner();
    const { seen } = await collect(runner, command(`printf '{"n":1}\\n{"n":2}\\ndata: {"n":3}\\n'`, { mode: "stream" }));
    expect(seen.frames).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(seen).toMatchObject({ ended: true });
    expect(seen.failure).toBeUndefined();
  });

  it("skips banners but fails when nothing parses", async () => {
    const runner = new SourceRunner();
    const mixed = await collect(runner, command(`echo starting; echo '{"ok":1}'`, { mode: "stream" }));
    expect(mixed.seen.frames).toEqual([{ ok: 1 }]);
    expect(mixed.seen.failure).toBeUndefined();
    const junk = await collect(runner, command("echo not json; echo still not", { mode: "stream" }));
    expect(junk.seen.failure).toMatchObject({ kind: "parse" });
  });

  it("fails with the exit code and stderr when the process dies", async () => {
    const runner = new SourceRunner();
    const { seen } = await collect(runner, command(`echo '{"a":1}'; echo oops >&2; exit 2`, { mode: "stream" }));
    expect(seen.frames).toEqual([{ a: 1 }]);
    expect(seen.failure).toMatchObject({ kind: "exit" });
    expect(seen.failure?.detail).toContain("oops");
  });

  it("stops a stream that goes quiet for longer than its idle timeout", async () => {
    const runner = new SourceRunner();
    const { seen } = await collect(runner, command(`echo '{"a":1}'; sleep 30`, { mode: "stream", timeoutSeconds: 0.3 }), {}, 900);
    expect(seen.failure).toMatchObject({ kind: "timeout" });
    expect(seen.failure?.message).toContain("timeoutSeconds");
  });

  it("keeps a quiet stream alive when the idle timeout is off, until it is stopped", async () => {
    const runner = new SourceRunner();
    const { seen, channel } = await collect(runner, command(`echo '{"a":1}'; sleep 30`, { mode: "stream", timeoutSeconds: 0 }), {}, 400);
    expect(seen.ended).toBe(false);
    channel.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(seen.ended).toBe(true);
    expect(seen.failure).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(runner.active).toBe(0);
  });

  it("stops at data: [DONE]", async () => {
    const runner = new SourceRunner();
    const { seen } = await collect(runner, command(`printf '{"n":1}\\ndata: [DONE]\\n{"n":2}\\n'`, { mode: "stream" }));
    expect(seen.frames).toEqual([{ n: 1 }]);
  });
});

describe("http sources", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://x");
      if (url.pathname === "/json") {
        response.setHeader("content-type", "application/json").end(JSON.stringify({ q: url.searchParams.get("host"), method: request.method, auth: request.headers.authorization ?? null }));
      } else if (url.pathname === "/post") {
        let body = "";
        request.on("data", (chunk: Buffer) => (body += chunk.toString()));
        request.on("end", () => response.setHeader("content-type", "application/json").end(JSON.stringify({ got: JSON.parse(body) })));
      } else if (url.pathname.startsWith("/echo")) {
        let body = "";
        request.on("data", (chunk: Buffer) => (body += chunk.toString()));
        request.on("end", () => response.setHeader("content-type", "application/json").end(JSON.stringify({ path: url.pathname, query: Object.fromEntries(url.searchParams), method: request.method, body: body ? JSON.parse(body) : null })));
      } else if (url.pathname === "/fail") {
        response.writeHead(503, "Service Unavailable").end("maintenance window");
      } else if (url.pathname === "/slow") {
        setTimeout(() => response.end("{}"), 3_000);
      } else if (url.pathname === "/sse") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(': hello\n\ndata: {"n":1}\n\n');
        setTimeout(() => response.write('event: tick\ndata: {"n":2}\n\n'), 50);
        setTimeout(() => response.end('data: {"n":3}\n\n'), 120);
      } else if (url.pathname === "/ndjson") {
        response.writeHead(200, { "content-type": "application/x-ndjson" }).end('{"n":1}\n{"n":2}\n');
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });
  const http = (pathname: string, extra: Partial<SourceSpec> = {}): SourceSpec => withDefaults({ type: "http", url: `${base}${pathname}`, ...extra });

  it("sends args as the query of a GET and as the JSON body of a POST", async () => {
    const runner = new SourceRunner();
    expect(await runner.once(http("/json"), { host: "api" }, context())).toMatchObject({ q: "api", method: "GET" });
    expect(await runner.once(http("/post", { method: "POST" }), { a: 1 }, context())).toEqual({ got: { a: 1 } });
  });

  it("fills path arguments, fixed query params and a fixed body, and keeps the rest in the right place", async () => {
    process.env.OPENUI_TEST_TOKEN = "s3cret";
    const runner = new SourceRunner();
    const get = withDefaults({ type: "http", url: `${base}/echo/{user}/stats`, query: { unit: "ms", key: "${OPENUI_TEST_TOKEN}" } });
    expect(await runner.once(get, { user: "a b", window: 5 }, context())).toMatchObject({ path: "/echo/a%20b/stats", query: { unit: "ms", window: "5", key: "s3cret" }, method: "GET" });
    const post = withDefaults({ type: "http", method: "POST", url: `${base}/echo/{id}`, query: { v: "2" }, body: { source: "paseo", n: 1 } });
    expect(await runner.once(post, { id: 7, n: 2 }, context())).toMatchObject({ path: "/echo/7", query: { v: "2" }, body: { source: "paseo", n: 2 } });
    expect(await kind(runner.once(get, {}, context()))).toBe("bad-args");
  });

  it("fills ${ENV} references in headers from the daemon's environment", async () => {
    process.env.OPENUI_TEST_TOKEN = "s3cret";
    const runner = new SourceRunner();
    const value = await runner.once(http("/json", { headers: { authorization: "Bearer ${OPENUI_TEST_TOKEN}" } }), {}, context());
    expect(value).toMatchObject({ auth: "Bearer s3cret" });
  });

  it("reports HTTP errors with the status and the start of the body", async () => {
    const runner = new SourceRunner();
    const error = await runner.once(http("/fail"), {}, context()).catch((caught: unknown) => caught as SourceError);
    expect(error).toMatchObject({ kind: "http" });
    expect((error as SourceError).message).toContain("503");
    expect((error as SourceError).detail).toContain("maintenance window");
    expect(await kind(runner.once(http("/missing"), {}, context()))).toBe("http");
  });

  it("times out and says so, and reports an unreachable host", async () => {
    const runner = new SourceRunner();
    expect(await kind(runner.once(http("/slow", { timeoutSeconds: 0.3 }), {}, context()))).toBe("timeout");
    const dead = withDefaults({ type: "http", url: "http://127.0.0.1:9/never" });
    const error = await runner.once(dead, {}, context()).catch((caught: unknown) => caught as SourceError);
    expect(error).toMatchObject({ kind: "network" });
    expect(runner.active).toBe(0);
  });

  it("streams SSE and NDJSON", async () => {
    const runner = new SourceRunner();
    const sse = await collect(runner, http("/sse", { mode: "stream" }), {}, 500);
    expect(sse.seen.frames).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(sse.seen).toMatchObject({ ended: true });
    expect(sse.seen.failure).toBeUndefined();
    const nd = await collect(runner, http("/ndjson", { mode: "stream" }), {}, 300);
    expect(nd.seen.frames).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("fails to open a stream the server refuses", async () => {
    const runner = new SourceRunner();
    expect(await kind(runner.stream(http("/fail", { mode: "stream" }), {}, context(), { frame() {}, end() {} }))).toBe("http");
  });
});

/** A bare WebSocket server: enough of RFC 6455 to push small text frames and read small masked ones. */
function socketServer(onConnect: (send: (text: string) => void, close: (code: number) => void, received: string[], headers: Record<string, string | string[] | undefined>) => void) {
  const server = createServer();
  const sockets = new Set<Socket>();
  server.on("upgrade", (request, socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const received: string[] = [];
    socket.on("data", (chunk: Buffer) => {
      if ((chunk[0] ?? 0) !== 0x81) return;
      const length = (chunk[1] ?? 0) & 0x7f;
      const mask = chunk.subarray(2, 6);
      const payload = Buffer.from(chunk.subarray(6, 6 + length).map((byte, index) => byte ^ (mask[index % 4] ?? 0)));
      received.push(payload.toString());
    });
    const send = (text: string) => {
      const payload = Buffer.from(text);
      socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    };
    const close = (code: number) => {
      socket.write(Buffer.from([0x88, 2, code >> 8, code & 0xff]));
      socket.end();
    };
    onConnect(send, close, received, request.headers);
  });
  return {
    async listen() {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
    },
    stop() {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

describe("websocket sources", () => {
  it("streams each message as a frame and ends when the server closes normally", async () => {
    const server = socketServer((send, close) => {
      send('{"n":1}');
      setTimeout(() => send('{"n":2}'), 30);
      setTimeout(() => close(1000), 80);
    });
    const url = await server.listen();
    const { seen } = await collect(new SourceRunner(), withDefaults({ type: "http", url }), {}, 500);
    expect(seen.frames).toEqual([{ n: 1 }, { n: 2 }]);
    expect(seen.ended).toBe(true);
    expect(seen.failure).toBeUndefined();
    server.stop();
  });

  it("sends the fixed body merged with the arguments as its opening message, with headers and query", async () => {
    let headers: Record<string, string | string[] | undefined> = {};
    const received: string[][] = [];
    const server = socketServer((send, _close, got, requestHeaders) => {
      headers = requestHeaders;
      received.push(got);
      setTimeout(() => send(JSON.stringify({ echoed: got })), 50);
    });
    const url = await server.listen();
    const spec = withDefaults({ type: "websocket", url: `${url}/feed?x=1`, query: { token: "t" }, body: { subscribe: "cpu", every: 1 }, headers: { "x-api-key": "k1" }, mode: "once" });
    expect(await new SourceRunner().once(spec, { every: 5 }, context())).toEqual({ echoed: ['{"subscribe":"cpu","every":5}'] });
    expect(headers["x-api-key"]).toBe("k1");
    server.stop();
  });

  it("fails with the close code when the server drops the connection", async () => {
    const server = socketServer((send, close) => {
      send('{"n":1}');
      setTimeout(() => close(1011), 40);
    });
    const url = await server.listen();
    const { seen } = await collect(new SourceRunner(), withDefaults({ type: "http", url }), {}, 400);
    expect(seen.frames).toEqual([{ n: 1 }]);
    expect(seen.failure).toMatchObject({ kind: "network" });
    expect(seen.failure?.message).toContain("1011");
    server.stop();
  });

  it("reports an unreachable socket and a quiet one", async () => {
    const runner = new SourceRunner();
    expect(await kind(runner.once(withDefaults({ type: "http", url: "ws://127.0.0.1:9/none", mode: "once" }), {}, context()))).toBe("network");
    const quiet = socketServer(() => undefined);
    const url = await quiet.listen();
    expect(await kind(runner.once(withDefaults({ type: "http", url, mode: "once", timeoutSeconds: 0.3 }), {}, context()))).toBe("timeout");
    const { seen } = await collect(runner, withDefaults({ type: "http", url, timeoutSeconds: 0.3 }), {}, 800);
    expect(seen.failure).toMatchObject({ kind: "timeout" });
    quiet.stop();
    expect(runner.active).toBe(0);
  });
});

describe("StreamHub", () => {
  const stream = (run: string, extra: Partial<SourceSpec> = {}) => command(run, { mode: "stream", ...extra });

  it("hands the latest frame to a long poll the moment it arrives", async () => {
    const hub = new StreamHub(new SourceRunner());
    const { id } = await hub.open("agent", stream(`echo '{"n":1}'; sleep 0.2; echo '{"n":2}'; sleep 5`, { timeoutSeconds: 0 }), {}, context());
    const first = await hub.read(id, 0, 2_000);
    expect(first).toMatchObject({ changed: true, state: "running" });
    const next = await hub.read(id, first.cursor, 2_000);
    expect(next).toMatchObject({ changed: true, data: { n: 2 } });
    const quiet = await hub.read(id, next.cursor, 150);
    expect(quiet).toMatchObject({ changed: false, state: "running" });
    hub.close();
  });

  it("keeps a window of frames when asked", async () => {
    const hub = new StreamHub(new SourceRunner());
    const { id } = await hub.open("agent", stream(`for i in 1 2 3 4 5; do echo "{\\"i\\":$i}"; done; sleep 5`, { window: 3, timeoutSeconds: 0 }), {}, context());
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await hub.read(id, 0, 0)).data).toEqual([{ i: 3 }, { i: 4 }, { i: 5 }]);
    hub.close();
  });

  it("shares one process between identical opens and stops it when the last holder leaves", async () => {
    const runner = new SourceRunner();
    const hub = new StreamHub(runner);
    const spec = stream(`echo '{"a":1}'; sleep 30`, { timeoutSeconds: 0 });
    const one = await hub.open("agent", spec, { x: 1 }, context());
    const two = await hub.open("agent", spec, { x: 1 }, context());
    const other = await hub.open("agent", spec, { x: 2 }, context());
    expect(two.id).toBe(one.id);
    expect(other.id).not.toBe(one.id);
    expect(hub.size).toBe(2);
    hub.release(one.id);
    expect(hub.size).toBe(2);
    hub.release(two.id);
    expect(hub.size).toBe(1);
    expect((await hub.read(one.id, 0, 0)).state).toBe("gone");
    hub.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(runner.active).toBe(0);
  });

  it("reports a failed stream and restarts it when opened again", async () => {
    const hub = new StreamHub(new SourceRunner());
    const spec = stream("echo oops >&2; exit 1");
    const { id } = await hub.open("agent", spec, {}, context());
    const read = await hub.read(id, 0, 2_000);
    expect(read).toMatchObject({ state: "failed", error: { kind: "exit" } });
    const again = await hub.open("agent", stream(`echo '{"back":true}'; sleep 5`, { timeoutSeconds: 0 }), {}, context());
    expect(again.id).not.toBe(id);
    expect((await hub.read(again.id, 0, 2_000)).data).toEqual({ back: true });
    hub.close();
  });

  it("limits streams per agent", async () => {
    const hub = new StreamHub(new SourceRunner(), { perAgent: 2, total: 10, abandonedMs: 60_000 });
    const spec = stream("sleep 30", { timeoutSeconds: 0 });
    await hub.open("a", spec, { n: 1 }, context());
    await hub.open("a", spec, { n: 2 }, context());
    expect(await kind(hub.open("a", spec, { n: 3 }, context()))).toBe("busy");
    await hub.open("b", spec, { n: 1 }, context());
    hub.close();
  });

  it("stops a stream nobody reads any more", async () => {
    const runner = new SourceRunner();
    const hub = new StreamHub(runner, { perAgent: 8, total: 32, abandonedMs: 200 }, 50);
    const { id } = await hub.open("agent", stream("sleep 30", { timeoutSeconds: 0 }), {}, context());
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await hub.read(id, 0, 0)).state).toBe("gone");
    hub.close();
  });

  it("closing the hub kills every process", async () => {
    const runner = new SourceRunner();
    const hub = new StreamHub(runner);
    await hub.open("agent", stream("sleep 30", { timeoutSeconds: 0 }), {}, context());
    expect(runner.active).toBe(1);
    hub.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(runner.active).toBe(0);
  });
});

