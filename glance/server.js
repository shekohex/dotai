// @ts-check

import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3000);
const ttlMs = Number(process.env.GLANCE_TTL_MS || 30 * 60 * 1000);
const maxUploadBytes = Number(process.env.GLANCE_MAX_UPLOAD_BYTES || 10 * 1024 * 1024);
const sweepIntervalMs = Number(process.env.GLANCE_SWEEP_INTERVAL_MS || 30 * 1000);
const maxImages = Number(process.env.GLANCE_MAX_IMAGES || 256);
const publicDir = join(fileURLToPath(new URL(".", import.meta.url)), "public");
const storageDir = process.env.GLANCE_STORAGE_DIR || "/dev/shm/glance";

/** @typedef {{ id: string, filePath: string, mimeType: string, extension: string, size: number, createdAt: number, expiresAt: number, etag: string, originalName: string }} ImageRecord */

/** @type {Map<string, ImageRecord>} */
const images = new Map();

const mimeTypes = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["image/avif", "avif"],
]);

const staticMimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

const sweepTimer = setInterval(sweepExpiredImages, sweepIntervalMs);
sweepTimer.unref();

const server = http.createServer(async (request, response) => {
  try {
    applySecurityHeaders(response);

    if (!request.url) {
      sendError(response, 400, "Bad request");
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);

    if (request.method === "GET" && url.pathname === "/") {
      await sendStaticFile(response, "index.html");
      return;
    }

    if (request.method === "GET" && url.pathname === "/favicon.svg") {
      await sendStaticFile(response, "favicon.svg");
      return;
    }

    if (request.method === "GET" && url.pathname === "/config") {
      sendJson(response, 200, {
        publicUrl: publicBaseUrl(request),
        ttlMs,
        maxUploadBytes,
        sweepIntervalMs,
        maxImages,
        storageDir,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/health") {
      await sendHealth(response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/status") {
      await sendStatus(response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/upload") {
      await uploadImage(request, response);
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/i/")) {
      await sendImage(url, request, response);
      return;
    }

    sendError(response, 404, "Not found");
  } catch {
    sendError(response, 500, "Internal server error");
  }
});

await mkdir(storageDir, { recursive: true });

server.listen(port, host, () => {
  console.log(`glance listening on http://${host}:${port}`);
  console.log(`glance storage ${storageDir}`);
});

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("uncaughtException", error => {
  console.error(error);
  shutdown("uncaughtException", 1);
});
process.once("unhandledRejection", reason => {
  console.error(reason);
  shutdown("unhandledRejection", 1);
});

/** @param {string} reason @param {number} [exitCode] */
function shutdown(reason, exitCode = 0) {
  console.log(`glance shutting down: ${reason}`);
  clearInterval(sweepTimer);
  clearImages();

  const forceExitTimer = setTimeout(() => {
    console.error("glance shutdown timed out");
    process.exit(1);
  }, 10_000);
  forceExitTimer.unref();

  server.close(error => {
    clearTimeout(forceExitTimer);
    if (error) {
      console.error(error);
      process.exit(1);
    }
    process.exit(exitCode);
  });
}

/** @param {http.IncomingMessage} request @param {http.ServerResponse} response */
async function uploadImage(request, response) {
  const contentType = String(request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  const extension = mimeTypes.get(contentType);

  if (!extension) {
    sendError(response, 415, "Unsupported image type");
    return;
  }

  const contentLength = Number(request.headers["content-length"] || 0);
  if (contentLength > maxUploadBytes) {
    sendError(response, 413, "Image too large");
    return;
  }

  const chunks = [];
  let receivedBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    receivedBytes += buffer.length;
    if (receivedBytes > maxUploadBytes) {
      sendError(response, 413, "Image too large");
      request.destroy();
      return;
    }
    chunks.push(buffer);
  }

  if (receivedBytes === 0) {
    sendError(response, 400, "Empty upload");
    return;
  }

  const buffer = Buffer.concat(chunks);
  const id = createImageId();
  const now = Date.now();
  const filePath = join(storageDir, `${id}.${extension}`);
  const etag = `"${createHash("sha256").update(buffer).digest("base64url")}"`;
  const originalName = safeHeaderValue(String(request.headers["x-file-name"] || `image.${extension}`));
  const record = { id, filePath, mimeType: contentType, extension, size: buffer.length, createdAt: now, expiresAt: now + ttlMs, etag, originalName };

  await writeFile(filePath, buffer, { flag: "wx" });
  images.set(id, record);
  evictOverflowImages();

  const imageUrl = `${publicBaseUrl(request)}/i/${id}.${extension}`;
  sendJson(response, 201, imageMetadata(record, imageUrl));
}

/** @param {URL} url @param {http.IncomingMessage} request @param {http.ServerResponse} response */
async function sendImage(url, request, response) {
  const match = /^\/i\/([A-Za-z0-9_-]{8,32})\.([A-Za-z0-9]+)$/.exec(url.pathname);
  if (!match) {
    sendError(response, 404, "Not found");
    return;
  }

  const [, id, requestedExtension] = match;
  const record = images.get(id);

  if (!record || record.expiresAt <= Date.now()) {
    deleteImage(id);
    sendError(response, 404, "Not found");
    return;
  }

  if (!existsSync(record.filePath)) {
    images.delete(id);
    sendError(response, 404, "Not found");
    return;
  }

  touchImage(record);

  const shouldDelete = url.searchParams.get("action") === "delete" || url.searchParams.has("delete") || String(request.headers["x-glance-action"] || "") === "delete";

  if (requestedExtension.toLowerCase() === "json") {
    sendJson(response, 200, imageMetadata(record, `${publicBaseUrl(request)}/i/${record.id}.${record.extension}`));
    if (shouldDelete) deleteImage(id);
    return;
  }

  if (requestedExtension.toLowerCase() !== record.extension) {
    sendError(response, 404, "Not found");
    return;
  }

  if (request.headers["if-none-match"] === record.etag) {
    response.writeHead(304, cacheHeaders(record));
    response.end();
    if (shouldDelete) deleteImage(id);
    return;
  }

  response.writeHead(200, {
    ...cacheHeaders(record),
    "Content-Type": record.mimeType,
    "Content-Length": record.size,
    "Content-Disposition": `inline; filename="${record.originalName}"`,
  });
  const stream = createReadStream(record.filePath);
  stream.pipe(response);
  if (shouldDelete) response.once("finish", () => deleteImage(id));
}

/** @param {http.ServerResponse} response @param {string} relativePath */
async function sendStaticFile(response, relativePath) {
  const normalizedPath = normalize(relativePath).replace(/^\.\.[/\\]/, "");
  const filePath = join(publicDir, normalizedPath);

  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    sendError(response, 404, "Not found");
    return;
  }

  const fileStat = await stat(filePath);
  response.writeHead(200, {
    "Content-Type": staticMimeTypes.get(extname(filePath)) || "application/octet-stream",
    "Content-Length": fileStat.size,
    "Cache-Control": "no-store",
  });
  createReadStream(filePath).pipe(response);
}

/** @param {http.ServerResponse} response */
async function sendHealth(response) {
  await mkdir(storageDir, { recursive: true });
  const healthFilePath = join(storageDir, `.health-${process.pid}`);
  await writeFile(healthFilePath, "ok");
  await unlink(healthFilePath);
  response.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": 2,
    "Cache-Control": "no-store",
  });
  response.end("OK");
}

/** @param {http.ServerResponse} response */
async function sendStatus(response) {
  const now = Date.now();
  const records = [...images.values()];
  const totalImageBytes = records.reduce((total, record) => total + record.size, 0);
  const oldestCreatedAt = records.reduce((oldest, record) => Math.min(oldest, record.createdAt), Number.POSITIVE_INFINITY);
  const newestCreatedAt = records.reduce((newest, record) => Math.max(newest, record.createdAt), 0);
  const nextExpiresAt = records.reduce((next, record) => Math.min(next, record.expiresAt), Number.POSITIVE_INFINITY);
  const byMimeType = records.reduce((counts, record) => {
    counts[record.mimeType] = (counts[record.mimeType] || 0) + 1;
    return counts;
  }, /** @type {Record<string, number>} */ ({}));
  const memoryUsage = process.memoryUsage();
  const storageStats = await stat(storageDir).catch(() => null);

  sendJson(response, 200, {
    ok: true,
    uptimeSeconds: Math.floor(process.uptime()),
    now: new Date(now).toISOString(),
    pid: process.pid,
    nodeVersion: process.version,
    config: {
      ttlMs,
      maxUploadBytes,
      sweepIntervalMs,
      maxImages,
      storageDir,
    },
    images: {
      count: records.length,
      capacity: maxImages,
      totalBytes: totalImageBytes,
      totalMegabytes: Number((totalImageBytes / 1024 / 1024).toFixed(3)),
      byMimeType,
      oldestCreatedAt: Number.isFinite(oldestCreatedAt) ? new Date(oldestCreatedAt).toISOString() : null,
      newestCreatedAt: newestCreatedAt > 0 ? new Date(newestCreatedAt).toISOString() : null,
      nextExpiresAt: Number.isFinite(nextExpiresAt) ? new Date(nextExpiresAt).toISOString() : null,
      nextExpirySeconds: Number.isFinite(nextExpiresAt) ? Math.max(0, Math.ceil((nextExpiresAt - now) / 1000)) : null,
    },
    memory: {
      rss: memoryUsage.rss,
      heapTotal: memoryUsage.heapTotal,
      heapUsed: memoryUsage.heapUsed,
      external: memoryUsage.external,
      arrayBuffers: memoryUsage.arrayBuffers,
    },
    storage: {
      exists: Boolean(storageStats),
      path: storageDir,
      mode: storageStats?.mode ?? null,
      modifiedAt: storageStats ? storageStats.mtime.toISOString() : null,
    },
  });
}

function sweepExpiredImages() {
  const now = Date.now();
  for (const [id, record] of images) {
    if (record.expiresAt <= now) deleteImage(id);
  }
}

function evictOverflowImages() {
  while (images.size > maxImages) {
    const firstId = images.keys().next().value;
    if (!firstId) return;
    deleteImage(firstId);
  }
}

/** @param {string} id */
function deleteImage(id) {
  const record = images.get(id);
  images.delete(id);
  if (record) unlink(record.filePath).catch(() => {});
}

function clearImages() {
  images.clear();
  rm(storageDir, { recursive: true, force: true }).catch(() => {});
}

/** @param {ImageRecord} record */
function touchImage(record) {
  images.delete(record.id);
  images.set(record.id, record);
}

function createImageId() {
  let id = randomBytes(9).toString("base64url");
  while (images.has(id)) id = randomBytes(9).toString("base64url");
  return id;
}

/** @param {http.IncomingMessage} request */
function publicBaseUrl(request) {
  const proto = request.headers["x-forwarded-proto"] || "http";
  const publicHost = process.env.PUBLIC_URL || `${proto}://${request.headers.host || `${host}:${port}`}`;
  return String(publicHost).replace(/\/$/, "");
}

/** @param {ImageRecord} record @param {string} url */
function imageMetadata(record, url) {
  const now = Date.now();
  return {
    id: record.id,
    url,
    jsonUrl: url.replace(/\.[^.]+$/, ".json"),
    size: record.size,
    mimeType: record.mimeType,
    extension: record.extension,
    originalName: record.originalName,
    createdAt: new Date(record.createdAt).toISOString(),
    expiresAt: new Date(record.expiresAt).toISOString(),
    ttlSeconds: Math.max(0, Math.ceil((record.expiresAt - now) / 1000)),
    maxAgeSeconds: Math.max(0, Math.floor((record.expiresAt - now) / 1000)),
  };
}

/** @param {ImageRecord} record */
function cacheHeaders(record) {
  const maxAgeSeconds = Math.max(0, Math.floor((record.expiresAt - Date.now()) / 1000));
  return {
    "Cache-Control": `public, max-age=${maxAgeSeconds}, immutable`,
    "ETag": record.etag,
    "Expires": new Date(record.expiresAt).toUTCString(),
    "X-Content-Type-Options": "nosniff",
  };
}

/** @param {http.ServerResponse} response */
function applySecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  response.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; style-src 'unsafe-inline' 'self' https://fonts.googleapis.com; style-src-elem 'unsafe-inline' 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'unsafe-inline' 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
}

/** @param {http.ServerResponse} response @param {number} status @param {unknown} body */
function sendJson(response, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
  });
  response.end(payload);
}

/** @param {http.ServerResponse} response @param {number} status @param {string} message */
function sendError(response, status, message) {
  if (response.headersSent) return;
  sendJson(response, status, { error: message });
}

/** @param {string} value */
function safeHeaderValue(value) {
  return value.replace(/["\r\n\\]/g, "").slice(0, 120) || "image";
}
