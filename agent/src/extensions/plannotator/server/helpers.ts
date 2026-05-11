/** Core HTTP helpers for Pi extension servers. parseBody, json, html, send, toWebRequest */

import type { IncomingMessage } from "node:http";
import type { ServerResponse } from "node:http";
import { Value } from "typebox/value";

import { Type } from "typebox";

const UnknownRecordSchema = Type.Record(Type.String(), Type.Unknown());
type RequestInitWithDuplex = RequestInit & { duplex?: "half" };

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

export function html(res: ServerResponse, content: string): void {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(content);
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
