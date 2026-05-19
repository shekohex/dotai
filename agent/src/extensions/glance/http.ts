import type { IncomingMessage, ServerResponse } from "node:http";
import { Value } from "typebox/value";
import { GlanceErrorResponseSchema, type GlanceErrorResponse } from "./schemas.js";

export function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}

export function sendError(response: ServerResponse, statusCode: number, error: string): void {
  const body: GlanceErrorResponse = { ok: false, error };
  if (!Value.Check(GlanceErrorResponseSchema, body)) {
    response.writeHead(500);
    response.end();
    return;
  }
  sendJson(response, statusCode, body);
}

export function readRequestBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Buffer | "oversize"> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    request.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      size += chunk.byteLength;
      if (size > maxBytes) {
        settled = true;
        request.pause();
        resolve("oversize");
        return;
      }
      chunks.push(chunk);
    });

    request.on("end", () => {
      if (!settled) {
        resolve(Buffer.concat(chunks, size));
      }
    });

    request.on("error", (error) => {
      if (!settled) {
        reject(error);
      }
    });
  });
}
