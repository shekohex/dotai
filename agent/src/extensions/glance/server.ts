import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, join } from "node:path";
import { Value } from "typebox/value";
import {
  GLANCE_DEFAULT_MAX_IMAGES,
  GLANCE_DEFAULT_MAX_UPLOAD_BYTES,
  GLANCE_DEFAULT_PORT,
  GLANCE_DEFAULT_TTL_MS,
  GLANCE_HEARTBEAT_FRESH_MS,
  GLANCE_IDLE_SHUTDOWN_MS,
  GLANCE_NAME,
  GLANCE_SCHEMA_VERSION,
  GLANCE_SUPPORTED_MIME_TYPES,
  GLANCE_SWEEP_INTERVAL_MS,
} from "./constants.js";
import { sendError, sendJson, readRequestBody } from "./http.js";
import { getImageExtension, normalizeMimeType, sanitizeOriginalFilename } from "./mime.js";
import { getGlancePaths, isPathInsideDirectory, type GlancePaths } from "./paths.js";
import {
  GlanceHeartbeatSchema,
  GlanceStatusSchema,
  type GlanceStatus,
  type GlanceUploadResponse,
} from "./schemas.js";
import {
  isRunningInCoderWorkspace,
  resolveCoderPublicBaseUrl,
} from "../../utils/browser-access.js";

export interface GlanceServerOptions {
  paths?: GlancePaths;
  host?: string;
  port?: number;
  maxUploadBytes?: number;
  ttlMs?: number;
  maxImages?: number;
  sweepIntervalMs?: number;
  heartbeatFreshMs?: number;
  idleShutdownMs?: number;
  environment?: NodeJS.ProcessEnv;
}

export interface GlanceServerHandle {
  server: Server;
  status: GlanceStatus;
  close: () => Promise<void>;
}

async function ensureDirectories(paths: GlancePaths): Promise<void> {
  await mkdir(paths.clientsDir, { recursive: true });
  await mkdir(paths.storageDir, { recursive: true });
}

async function hasFreshHeartbeat(
  paths: GlancePaths,
  now: number,
  heartbeatFreshMs: number,
): Promise<boolean> {
  const entries = await readdir(paths.clientsDir).catch(() => []);
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const path = join(paths.clientsDir, entry);
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (!Value.Check(GlanceHeartbeatSchema, parsed)) {
        await rm(path, { force: true });
        continue;
      }
      if (now - parsed.updatedAt <= heartbeatFreshMs) {
        return true;
      }
      await rm(path, { force: true });
    } catch {
      await rm(path, { force: true });
    }
  }
  return false;
}

async function sweepStorage(paths: GlancePaths, ttlMs: number, maxImages: number): Promise<void> {
  const now = Date.now();
  const entries = await readdir(paths.storageDir).catch(() => []);
  const files: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    const path = join(paths.storageDir, entry);
    if (!isPathInsideDirectory(path, paths.storageDir)) {
      continue;
    }
    try {
      const fileStat = await stat(path);
      if (!fileStat.isFile()) {
        continue;
      }
      if (now - fileStat.mtimeMs > ttlMs) {
        await rm(path, { force: true });
        continue;
      }
      files.push({ path, mtimeMs: fileStat.mtimeMs });
    } catch {}
  }

  files.sort((left, right) => left.mtimeMs - right.mtimeMs);
  for (const file of files.slice(0, Math.max(0, files.length - maxImages))) {
    await rm(file.path, { force: true });
  }
}

async function deleteImageByName(paths: GlancePaths, name: string): Promise<boolean> {
  if (basename(name) !== name || !/^[0-9a-f-]+\.(?:png|jpg|webp|gif|avif)$/u.test(name)) {
    return false;
  }
  const path = join(paths.storageDir, name);
  if (!isPathInsideDirectory(path, paths.storageDir)) {
    return false;
  }
  await rm(path, { force: true });
  return true;
}

function getGlanceResourcePath(name: "favicon.svg" | "index.html"): string {
  return join(import.meta.dirname, "..", "..", "resources", "glance", name);
}

function joinGlanceUrl(baseUrl: string, path: string): string {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path, normalizedBaseUrl).toString();
}

interface GlanceRequestHandlerOptions {
  status: GlanceStatus;
  port: number;
  startedAt: number;
  paths: GlancePaths;
  maxUploadBytes: number;
  ttlMs: number;
}

async function handleGlanceRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: GlanceRequestHandlerOptions,
): Promise<void> {
  const url = new URL(request.url ?? "/", options.status.baseUrl);
  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      name: GLANCE_NAME,
      schemaVersion: GLANCE_SCHEMA_VERSION,
      pid: process.pid,
      port: options.port,
      startedAt: options.startedAt,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/config") {
    sendJson(response, 200, {
      ok: true,
      maxUploadBytes: options.maxUploadBytes,
      storageDir: options.paths.storageDir,
      publicUrl: options.status.publicBaseUrl ?? options.status.baseUrl,
      supportedMimeTypes: [...GLANCE_SUPPORTED_MIME_TYPES],
    });
    return;
  }

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/upload")) {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(await readFile(getGlanceResourcePath("index.html"), "utf8"));
    return;
  }

  if (request.method === "GET" && url.pathname === "/favicon.svg") {
    response.writeHead(200, {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=86400",
    });
    response.end(await readFile(getGlanceResourcePath("favicon.svg"), "utf8"));
    return;
  }

  if (request.method === "DELETE" && url.pathname.startsWith("/i/")) {
    const deleted = await deleteImageByName(
      options.paths,
      decodeURIComponent(url.pathname.slice(3)),
    );
    sendJson(response, deleted ? 200 : 404, { ok: deleted });
    return;
  }

  if (request.method !== "POST" || url.pathname !== "/upload") {
    sendError(response, 404, "not found");
    return;
  }

  const contentLength = request.headers["content-length"];
  if (typeof contentLength === "string" && Number(contentLength) > options.maxUploadBytes) {
    sendError(response, 413, "upload too large");
    return;
  }

  const mimeType = normalizeMimeType(request.headers["content-type"]);
  const extension = mimeType === null ? null : getImageExtension(mimeType);
  if (mimeType === null || extension === null) {
    sendError(response, 415, "unsupported image type");
    return;
  }

  const body = await readRequestBody(request, options.maxUploadBytes).catch(() => null);
  if (body === "oversize") {
    sendError(response, 413, "upload too large");
    return;
  }
  if (body === null || body.byteLength === 0) {
    sendError(response, 400, "empty upload");
    return;
  }

  const id = randomUUID();
  const path = join(options.paths.storageDir, `${id}.${extension}`);
  if (!isPathInsideDirectory(path, options.paths.storageDir)) {
    sendError(response, 500, "invalid storage path");
    return;
  }

  await writeFile(path, body, { flag: "wx" });
  const createdAt = new Date();
  const originalNameHeader = request.headers["x-file-name"];
  const originalName = typeof originalNameHeader === "string" ? originalNameHeader : undefined;
  const uploadResponse: GlanceUploadResponse = {
    ok: true,
    id,
    imageUrl: joinGlanceUrl(
      options.status.publicBaseUrl ?? options.status.baseUrl,
      `i/${id}.${extension}`,
    ),
    path,
    size: body.byteLength,
    mimeType,
    extension,
    originalName: sanitizeOriginalFilename(originalName),
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + options.ttlMs).toISOString(),
  };
  sendJson(response, 200, uploadResponse);
}

export async function createGlanceServer(
  options: GlanceServerOptions = {},
): Promise<GlanceServerHandle> {
  const paths = options.paths ?? getGlancePaths();
  const port = options.port ?? GLANCE_DEFAULT_PORT;
  const environment = options.environment ?? process.env;
  const host = options.host ?? (isRunningInCoderWorkspace(environment) ? "0.0.0.0" : "127.0.0.1");
  const maxUploadBytes = options.maxUploadBytes ?? GLANCE_DEFAULT_MAX_UPLOAD_BYTES;
  const ttlMs = options.ttlMs ?? GLANCE_DEFAULT_TTL_MS;
  const maxImages = options.maxImages ?? GLANCE_DEFAULT_MAX_IMAGES;
  const sweepIntervalMs = options.sweepIntervalMs ?? GLANCE_SWEEP_INTERVAL_MS;
  const heartbeatFreshMs = options.heartbeatFreshMs ?? GLANCE_HEARTBEAT_FRESH_MS;
  const idleShutdownMs = options.idleShutdownMs ?? GLANCE_IDLE_SHUTDOWN_MS;
  const startedAt = Date.now();

  await ensureDirectories(paths);

  const status: GlanceStatus = {
    schemaVersion: GLANCE_SCHEMA_VERSION,
    pid: process.pid,
    host,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    publicBaseUrl: resolveCoderPublicBaseUrl(port, environment),
    storageDir: paths.storageDir,
    startedAt,
    updatedAt: startedAt,
  };

  const handlerOptions = { status, port, startedAt, paths, maxUploadBytes, ttlMs };

  const server = createServer((request, response) => {
    void handleGlanceRequest(request, response, handlerOptions).catch(() => {
      if (response.headersSent) {
        response.end();
      } else {
        sendError(response, 500, "upload failed");
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  await writeFile(paths.statusTmpPath, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
  await rename(paths.statusTmpPath, paths.statusPath);

  let lastFreshHeartbeatAt = Date.now();
  const sweepTimer = setInterval(() => {
    void sweepStorage(paths, ttlMs, maxImages);
  }, sweepIntervalMs);
  const heartbeatTimer = setInterval(() => {
    void (async () => {
      if (await hasFreshHeartbeat(paths, Date.now(), heartbeatFreshMs)) {
        lastFreshHeartbeatAt = Date.now();
        return;
      }
      if (Date.now() - lastFreshHeartbeatAt >= idleShutdownMs) {
        clearInterval(sweepTimer);
        clearInterval(heartbeatTimer);
        server.close();
      }
    })();
  }, sweepIntervalMs);

  const close = async (): Promise<void> => {
    clearInterval(sweepTimer);
    clearInterval(heartbeatTimer);
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  };

  return { server, status, close };
}

export async function runGlanceDaemon(options: GlanceServerOptions = {}): Promise<void> {
  const handle = await createGlanceServer(options);
  const close = (): void => {
    void handle.close();
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
  if (process.platform !== "win32") {
    process.once("SIGHUP", close);
  }
  await new Promise<void>((resolve) => {
    handle.server.on("close", () => {
      resolve();
    });
  });
  const current = await readFile((options.paths ?? getGlancePaths()).statusPath, "utf8").catch(
    () => null,
  );
  if (current !== null) {
    const parsed = JSON.parse(current) as unknown;
    if (
      Value.Check(GlanceStatusSchema, parsed) &&
      parsed.pid === process.pid &&
      parsed.startedAt === handle.status.startedAt
    ) {
      await rm((options.paths ?? getGlancePaths()).statusPath, { force: true });
    }
  }
  process.off("SIGTERM", close);
  process.off("SIGINT", close);
  if (process.platform !== "win32") {
    process.off("SIGHUP", close);
  }
}
