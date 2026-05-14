import { brotliDecompressSync, gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { html } from "../src/extensions/plannotator/server/helpers.ts";

type CapturedResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer;
};

function createResponse(): {
  response: CapturedResponse;
  res: {
    writeHead: (status: number, headers: Record<string, string>) => void;
    end: (chunk: string | Buffer) => void;
  };
} {
  const response: CapturedResponse = { statusCode: 200, headers: {}, body: Buffer.alloc(0) };
  return {
    response,
    res: {
      writeHead(status, headers) {
        response.statusCode = status;
        response.headers = headers;
      },
      end(chunk) {
        response.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      },
    },
  };
}

function createRequest(acceptEncoding: string): { headers: { "accept-encoding": string } } {
  return { headers: { "accept-encoding": acceptEncoding } };
}

describe("plannotator HTML compression", () => {
  const content = `<html>${"hello".repeat(1000)}</html>`;

  it("prefers Brotli for UI HTML", () => {
    const { response, res } = createResponse();

    html(res as never, content, createRequest("gzip, br") as never);

    expect(response.statusCode).toBe(200);
    expect(response.headers["Content-Encoding"]).toBe("br");
    expect(response.headers["Cache-Control"]).toBe("private, max-age=3600, immutable");
    expect(response.headers.Vary).toBe("Accept-Encoding");
    expect(brotliDecompressSync(response.body).toString()).toBe(content);
  });

  it("falls back to gzip when Brotli is unavailable", () => {
    const { response, res } = createResponse();

    html(res as never, content, createRequest("gzip") as never);

    expect(response.headers["Content-Encoding"]).toBe("gzip");
    expect(gunzipSync(response.body).toString()).toBe(content);
  });
});
