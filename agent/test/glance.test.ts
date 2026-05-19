import { mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { createServer as createNodeServer, request as httpRequest, type Server } from "node:http";
import { join } from "node:path";
import { Value } from "typebox/value";
import { afterEach, expect, it } from "vitest";
import {
  cleanGlanceStorage,
  ensureGlanceDaemon,
  startGlanceHeartbeat,
  stopGlanceDaemon,
} from "../src/extensions/glance/daemon.js";
import {
  isSupportedImageMimeType,
  sanitizeOriginalFilename,
} from "../src/extensions/glance/mime.js";
import { getGlancePaths, isPathInsideDirectory } from "../src/extensions/glance/paths.js";
import { createGlanceServer, type GlanceServerHandle } from "../src/extensions/glance/server.js";
import {
  GlanceConfigSchema,
  GlanceHeartbeatSchema,
  GlanceHealthSchema,
  GlanceStatusSchema,
  GlanceUploadResponseSchema,
} from "../src/extensions/glance/schemas.js";
import { createTempDir } from "./test-utils/temp-paths.js";

const handles: GlanceServerHandle[] = [];
const daemonPids = new Set<number>();
const nodeServers: Server[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close().catch(() => undefined)));
  await Promise.all(
    nodeServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
  for (const pid of daemonPids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  daemonPids.clear();
});

async function createServer(
  port?: number,
  options: {
    ttlMs?: number;
    maxImages?: number;
    maxUploadBytes?: number;
    sweepIntervalMs?: number;
    heartbeatFreshMs?: number;
    idleShutdownMs?: number;
    environment?: NodeJS.ProcessEnv;
  } = {},
) {
  const resolvedPort = port ?? (await getFreePort());
  const agentDir = await createTempDir("glance-agent-");
  const paths = getGlancePaths(agentDir);
  const handle = await createGlanceServer({
    paths,
    port: resolvedPort,
    host: "127.0.0.1",
    environment: options.environment ?? {},
    ttlMs: options.ttlMs,
    maxImages: options.maxImages,
    maxUploadBytes: options.maxUploadBytes,
    sweepIntervalMs: options.sweepIntervalMs,
    heartbeatFreshMs: options.heartbeatFreshMs,
    idleShutdownMs: options.idleShutdownMs,
  });
  handles.push(handle);
  return { handle, paths, baseUrl: `http://127.0.0.1:${resolvedPort}`, port: resolvedPort };
}

async function getFreePort(): Promise<number> {
  const server = createNodeServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  if (address === null || typeof address === "string") {
    throw new Error("Failed to allocate free port");
  }
  return address.port;
}

async function postChunkedUpload(url: string, bytes: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      { method: "POST", headers: { "content-type": "image/png" } },
      (response) => {
        response.resume();
        response.on("end", () => {
          resolve(response.statusCode ?? 0);
        });
      },
    );
    request.on("error", reject);
    request.write(bytes);
    request.end();
  });
}

it("validates MIME types and sanitizes filenames", () => {
  expect(isSupportedImageMimeType("image/png")).toBe(true);
  expect(isSupportedImageMimeType("text/plain")).toBe(false);
  expect(sanitizeOriginalFilename('..\\bad/"name\r\n.png')).toBe(".._bad_name.png");
});

it("keeps storage paths bounded", async () => {
  const agentDir = await createTempDir("glance-paths-");
  const paths = getGlancePaths(agentDir);
  expect(isPathInsideDirectory(join(paths.storageDir, "image.png"), paths.storageDir)).toBe(true);
  expect(isPathInsideDirectory(join(paths.storageDir, "..", "escape.png"), paths.storageDir)).toBe(
    false,
  );
});

it("writes and removes heartbeat files with valid schema", async () => {
  const agentDir = await createTempDir("glance-heartbeat-");
  const paths = getGlancePaths(agentDir);
  const heartbeat = await startGlanceHeartbeat({ paths, cwd: agentDir });
  const parsed = JSON.parse(await readFile(heartbeat.path, "utf8")) as unknown;
  expect(Value.Check(GlanceHeartbeatSchema, parsed)).toBe(true);
  await heartbeat.stop();
  await expect(readFile(heartbeat.path, "utf8")).rejects.toThrow();
});

it("serves health and config schemas", async () => {
  const { baseUrl, paths, handle } = await createServer();
  expect(
    Value.Check(
      GlanceStatusSchema,
      JSON.parse(await readFile(paths.statusPath, "utf8")) as unknown,
    ),
  ).toBe(true);
  const health = (await (await fetch(`${baseUrl}/health`)).json()) as unknown;
  const config = (await (await fetch(`${baseUrl}/config`)).json()) as unknown;
  expect(Value.Check(GlanceHealthSchema, health)).toBe(true);
  expect(Value.Check(GlanceConfigSchema, config)).toBe(true);
  expect(handle.status.storageDir).toBe(paths.storageDir);
});

it("stores valid image uploads under runtime storage", async () => {
  const { baseUrl, paths } = await createServer();
  const response = await fetch(`${baseUrl}/upload`, {
    method: "POST",
    headers: { "content-type": "image/png", "x-file-name": "screen/shot.png" },
    body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  });
  const body = (await response.json()) as unknown;
  expect(response.status).toBe(200);
  expect(Value.Check(GlanceUploadResponseSchema, body)).toBe(true);
  if (!Value.Check(GlanceUploadResponseSchema, body)) {
    throw new Error("invalid upload response");
  }
  expect(isPathInsideDirectory(body.path, paths.storageDir)).toBe(true);
  expect(body.imageUrl).toBe(`${baseUrl}/i/${body.id}.png`);
  expect(await readFile(body.path)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  expect(body.originalName).toBe("screen_shot.png");
});

it("deletes uploaded images by image URL", async () => {
  const { baseUrl } = await createServer();
  const uploadResponse = await fetch(`${baseUrl}/upload`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: Buffer.from([1, 2, 3]),
  });
  const body = (await uploadResponse.json()) as unknown;
  if (!Value.Check(GlanceUploadResponseSchema, body)) {
    throw new Error("invalid upload response");
  }
  expect(await readFile(body.path)).toEqual(Buffer.from([1, 2, 3]));
  const deleteResponse = await fetch(body.imageUrl, { method: "DELETE" });
  expect(deleteResponse.status).toBe(200);
  await expect(readFile(body.path)).rejects.toThrow();
});

it("returns public image URL when Coder public base URL is available", async () => {
  const { baseUrl, port } = await createServer(undefined, {
    environment: {
      CODER: "true",
      CODER_WILDCARD_ACCESS_URL: "https://*.coder.example",
      CODER_WORKSPACE_OWNER_NAME: "owner",
      CODER_WORKSPACE_NAME: "workspace",
      CODER_WORKSPACE_AGENT_NAME: "agent",
    },
  });
  const response = await fetch(`${baseUrl}/upload`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: Buffer.from([1]),
  });
  const body = (await response.json()) as unknown;
  if (!Value.Check(GlanceUploadResponseSchema, body)) {
    throw new Error("invalid upload response");
  }
  expect(body.imageUrl).toBe(
    `https://${port}--agent--workspace--owner.coder.example/i/${body.id}.png`,
  );
});

it("rejects delete path traversal and unsupported image names", async () => {
  const { baseUrl } = await createServer();
  expect(await fetch(`${baseUrl}/i/../x.png`, { method: "DELETE" })).toMatchObject({ status: 404 });
  expect(await fetch(`${baseUrl}/i/not-an-image.txt`, { method: "DELETE" })).toMatchObject({
    status: 404,
  });
});

it("rejects empty, unsupported, and oversize uploads", async () => {
  const { baseUrl } = await createServer(undefined, { maxUploadBytes: 3 });
  expect(
    await fetch(`${baseUrl}/upload`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: Buffer.alloc(0),
    }),
  ).toMatchObject({ status: 400 });
  expect(
    await fetch(`${baseUrl}/upload`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "abc",
    }),
  ).toMatchObject({ status: 415 });
  expect(
    await fetch(`${baseUrl}/upload`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: Buffer.alloc(4),
    }),
  ).toMatchObject({ status: 413 });
  await expect(postChunkedUpload(`${baseUrl}/upload`, Buffer.alloc(4))).resolves.toBe(413);
});

it("creates unique files for concurrent uploads", async () => {
  const { baseUrl } = await createServer();
  const responses = await Promise.all(
    Array.from({ length: 8 }, () =>
      fetch(`${baseUrl}/upload`, {
        method: "POST",
        headers: { "content-type": "image/jpeg" },
        body: Buffer.from([1, 2, 3]),
      }),
    ),
  );
  const bodies = await Promise.all(
    responses.map(async (response) => response.json() as Promise<unknown>),
  );
  const ids = bodies.map((body) => {
    if (!Value.Check(GlanceUploadResponseSchema, body)) {
      throw new Error("invalid upload response");
    }
    return body.id;
  });
  expect(new Set(ids).size).toBe(ids.length);
});

it("evicts old files by max image count", async () => {
  const { baseUrl, paths } = await createServer(undefined, { maxImages: 1, sweepIntervalMs: 20 });
  await fetch(`${baseUrl}/upload`, {
    method: "POST",
    headers: { "content-type": "image/gif" },
    body: Buffer.from([1]),
  });
  await fetch(`${baseUrl}/upload`, {
    method: "POST",
    headers: { "content-type": "image/gif" },
    body: Buffer.from([2]),
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(await readdir(paths.storageDir)).toHaveLength(1);
});

it("removes malformed heartbeat files during sweep", async () => {
  const { paths } = await createServer(undefined, { sweepIntervalMs: 20 });
  const malformedPath = join(paths.clientsDir, "bad.json");
  await writeFile(malformedPath, "{ nope");
  await new Promise((resolve) => setTimeout(resolve, 80));
  await expect(readFile(malformedPath, "utf8")).rejects.toThrow();
});

it("can remove expired files", async () => {
  const { baseUrl, paths } = await createServer(undefined, { ttlMs: 1, sweepIntervalMs: 20 });
  await fetch(`${baseUrl}/upload`, {
    method: "POST",
    headers: { "content-type": "image/avif" },
    body: Buffer.from([1]),
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(await readdir(paths.storageDir)).toHaveLength(0);
});

it("keeps bulk clean local-only and supports local helper", async () => {
  const { baseUrl, paths } = await createServer();
  await fetch(`${baseUrl}/upload`, {
    method: "POST",
    headers: { "content-type": "image/webp" },
    body: Buffer.from([1]),
  });
  expect(await readdir(paths.storageDir)).toHaveLength(1);
  expect(await fetch(`${baseUrl}/clean`, { method: "POST" })).toMatchObject({ status: 404 });
  await fetch(`${baseUrl}/upload`, {
    method: "POST",
    headers: { "content-type": "image/webp" },
    body: Buffer.from([1]),
  });
  expect(await cleanGlanceStorage(paths)).toBe(2);
  expect(await readdir(paths.storageDir)).toHaveLength(0);
});

it("cleans temp runtime directory manually when needed", async () => {
  const agentDir = await createTempDir("glance-cleanup-");
  await rm(agentDir, { recursive: true, force: true });
  await expect(readFile(agentDir, "utf8")).rejects.toThrow();
});

it("starts one daemon and reuses healthy status", async () => {
  const agentDir = await createTempDir("glance-daemon-");
  const paths = getGlancePaths(agentDir);
  const heartbeat = await startGlanceHeartbeat({ paths, cwd: agentDir });
  const firstStatus = await ensureGlanceDaemon({ paths, port: 39290 });
  daemonPids.add(firstStatus.pid);
  const secondStatus = await ensureGlanceDaemon({ paths, port: 39290 });
  expect(secondStatus.pid).toBe(firstStatus.pid);
  await heartbeat.stop();
}, 15_000);

it("replaces malformed stale status after daemon start", async () => {
  const agentDir = await createTempDir("glance-malformed-status-");
  const paths = getGlancePaths(agentDir);
  await mkdir(paths.runtimeDir, { recursive: true });
  await writeFile(paths.statusPath, "{ nope");
  const heartbeat = await startGlanceHeartbeat({ paths, cwd: agentDir });
  const status = await ensureGlanceDaemon({ paths, port: 39291 });
  daemonPids.add(status.pid);
  expect(
    Value.Check(
      GlanceStatusSchema,
      JSON.parse(await readFile(paths.statusPath, "utf8")) as unknown,
    ),
  ).toBe(true);
  await heartbeat.stop();
}, 15_000);

it("breaks stale startup lock when no daemon is healthy", async () => {
  const agentDir = await createTempDir("glance-stale-lock-");
  const paths = getGlancePaths(agentDir);
  await mkdir(paths.lockDir, { recursive: true });
  const oldTime = new Date(Date.now() - 20_000);
  await utimes(paths.lockDir, oldTime, oldTime);
  const heartbeat = await startGlanceHeartbeat({ paths, cwd: agentDir });
  const status = await ensureGlanceDaemon({ paths, port: 39292 });
  daemonPids.add(status.pid);
  expect(status.port).toBe(39292);
  await heartbeat.stop();
}, 15_000);

it("keeps daemon alive while any heartbeat is fresh", async () => {
  const { baseUrl, paths } = await createServer(undefined, {
    sweepIntervalMs: 20,
    heartbeatFreshMs: 500,
    idleShutdownMs: 1_000,
  });
  const first = await startGlanceHeartbeat({ paths });
  const second = await startGlanceHeartbeat({ paths });
  await first.stop();
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
  await second.stop();
});

it("shuts down after all heartbeats expire", async () => {
  const { baseUrl, paths } = await createServer(undefined, {
    sweepIntervalMs: 20,
    heartbeatFreshMs: 20,
    idleShutdownMs: 40,
  });
  const heartbeat = await startGlanceHeartbeat({ paths });
  await heartbeat.stop();
  await new Promise((resolve) => setTimeout(resolve, 120));
  await expect(fetch(`${baseUrl}/health`)).rejects.toThrow();
});

it("starts daemon when status is stale and no server is healthy", async () => {
  const agentDir = await createTempDir("glance-stale-status-");
  const paths = getGlancePaths(agentDir);
  await mkdir(paths.runtimeDir, { recursive: true });
  await writeFile(
    paths.statusPath,
    `${JSON.stringify({
      schemaVersion: 1,
      pid: 1,
      host: "127.0.0.1",
      port: 39295,
      baseUrl: "http://127.0.0.1:39295",
      publicBaseUrl: null,
      storageDir: paths.storageDir,
      startedAt: 1,
      updatedAt: 1,
    })}\n`,
  );
  const heartbeat = await startGlanceHeartbeat({ paths, cwd: agentDir });
  const status = await ensureGlanceDaemon({ paths, port: 39295 });
  daemonPids.add(status.pid);
  expect(status.pid).not.toBe(1);
  await heartbeat.stop();
}, 15_000);

it("fresh startup lock makes competing process wait then fail", async () => {
  const agentDir = await createTempDir("glance-fresh-lock-");
  const paths = getGlancePaths(agentDir);
  const port = await getFreePort();
  await mkdir(paths.lockDir, { recursive: true });
  await expect(ensureGlanceDaemon({ paths, port, startupTimeoutMs: 120 })).rejects.toThrow(
    /failed to start|timed out/,
  );
}, 15_000);

it("port occupied by non-Glance fails without healthy status", async () => {
  const agentDir = await createTempDir("glance-port-collision-");
  const paths = getGlancePaths(agentDir);
  const port = await getFreePort();
  const server = createNodeServer((_request, response) => {
    response.end("not glance");
  });
  nodeServers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve();
    });
  });
  await expect(ensureGlanceDaemon({ paths, port, startupTimeoutMs: 600 })).rejects.toThrow(
    /non-Glance/,
  );
}, 15_000);

it("daemon crash is detected on next ensure", async () => {
  const agentDir = await createTempDir("glance-crash-restart-");
  const paths = getGlancePaths(agentDir);
  const heartbeat = await startGlanceHeartbeat({ paths, cwd: agentDir });
  const firstStatus = await ensureGlanceDaemon({ paths, port: 39298 });
  process.kill(firstStatus.pid, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const secondStatus = await ensureGlanceDaemon({ paths, port: 39298 });
  daemonPids.add(secondStatus.pid);
  expect(secondStatus.pid).not.toBe(firstStatus.pid);
  await heartbeat.stop();
}, 15_000);

it("stops daemon with SIGTERM and clears status", async () => {
  const agentDir = await createTempDir("glance-stop-daemon-");
  const paths = getGlancePaths(agentDir);
  const heartbeat = await startGlanceHeartbeat({ paths, cwd: agentDir });
  const status = await ensureGlanceDaemon({ paths, port: 39303 });
  expect(await stopGlanceDaemon(paths)).toBe("stopped");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await expect(fetch(`${status.baseUrl}/health`)).rejects.toThrow();
  await expect(readFile(paths.statusPath, "utf8")).rejects.toThrow();
  await heartbeat.stop();
}, 15_000);
