/** Core HTTP helpers for Pi extension servers. parseBody, json, html, send, toWebRequest */

import type { IncomingMessage } from "node:http";
import type { ServerResponse } from "node:http";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import { Value } from "typebox/value";

import { Type } from "typebox";

const UnknownRecordSchema = Type.Record(Type.String(), Type.Unknown());
type RequestInitWithDuplex = RequestInit & { duplex?: "half" };

const HTML_CACHE_CONTROL = "private, max-age=3600, immutable";
const MIN_COMPRESS_BYTES = 1024;
const htmlCompressionCache = new Map<
  string,
  {
    identity: Buffer;
    br: Buffer;
    gzip: Buffer;
  }
>();

function parseAcceptEncoding(header: string | undefined): Set<string> {
  if (header === undefined || header.length === 0) {
    return new Set();
  }
  return new Set(
    header
      .split(",")
      .map((entry) => entry.trim().split(";", 1)[0]?.toLowerCase())
      .filter((entry): entry is string => entry !== undefined && entry.length > 0),
  );
}

function getCompressedHtml(content: string): { identity: Buffer; br: Buffer; gzip: Buffer } {
  const cached = htmlCompressionCache.get(content);
  if (cached !== undefined) {
    return cached;
  }
  const identity = Buffer.from(content);
  const compressed = {
    identity,
    br: brotliCompressSync(identity, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_MAX_QUALITY,
        [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
      },
    }),
    gzip: gzipSync(identity, { level: zlibConstants.Z_BEST_COMPRESSION }),
  };
  htmlCompressionCache.set(content, compressed);
  return compressed;
}

export function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: string) => (data += chunk));
    req.on("end", () => {
      try {
        const parsed: unknown = JSON.parse(data);
        resolve(
          Value.Check(UnknownRecordSchema, parsed) ? Value.Parse(UnknownRecordSchema, parsed) : {},
        );
      } catch {
        resolve({});
      }
    });
  });
}

export function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export function html(res: ServerResponse, content: string, req?: IncomingMessage): void {
  const headers: Record<string, string> = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": HTML_CACHE_CONTROL,
    Vary: "Accept-Encoding",
  };
  if (Buffer.byteLength(content) < MIN_COMPRESS_BYTES || req === undefined) {
    res.writeHead(200, headers);
    res.end(content);
    return;
  }
  const acceptedEncodings = parseAcceptEncoding(req.headers["accept-encoding"]);
  const compressed = getCompressedHtml(content);
  if (acceptedEncodings.has("br")) {
    res.writeHead(200, { ...headers, "Content-Encoding": "br" });
    res.end(compressed.br);
    return;
  }
  if (acceptedEncodings.has("gzip")) {
    res.writeHead(200, { ...headers, "Content-Encoding": "gzip" });
    res.end(compressed.gzip);
    return;
  }
  res.writeHead(200, headers);
  res.end(compressed.identity);
}

export function send(
  res: ServerResponse,
  body: string | Buffer,
  status = 200,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, headers);
  res.end(body);
}

export function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://localhost");
}

async function readRequestBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk));
    } else if (chunk instanceof Buffer) {
      chunks.push(chunk);
    } else {
      chunks.push(Buffer.from(chunk));
    }
  }
  return Buffer.concat(chunks);
}

export async function toWebRequest(req: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }

  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers,
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    const body = await readRequestBody(req);
    const requestInit: RequestInitWithDuplex = {
      ...init,
      body: new Blob([Buffer.from(body)]),
      duplex: "half",
    };
    return new Request(`http://localhost${req.url ?? "/"}`, requestInit);
  }

  return new Request(`http://localhost${req.url ?? "/"}`, init);
}
