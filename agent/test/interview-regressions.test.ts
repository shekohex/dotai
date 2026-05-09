import http from "node:http";
import os from "node:os";
import { rm } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadSavedInterview } from "../src/extensions/interview/questions.js";
import { startInterviewServer } from "../src/extensions/interview/server.js";
import { normalizePath } from "../src/extensions/interview/server-session-store.js";
import { createTempDir as createRegisteredTempDir } from "./test-utils/temp-paths.ts";

interface JsonResponse {
  statusCode: number;
  body: string;
  json: unknown;
}

const cleanupPaths = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...cleanupPaths].map(async (filePath) => {
      await rm(filePath, { recursive: true, force: true });
      cleanupPaths.delete(filePath);
    }),
  );
});

async function createTempDir(prefix: string, parentDir: string = os.tmpdir()): Promise<string> {
  const tempDir = await createRegisteredTempDir(prefix, parentDir);
  cleanupPaths.add(tempDir);
  return tempDir;
}

async function requestJson(options: {
  port: number;
  path: string;
  body: unknown;
}): Promise<JsonResponse> {
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: "POST",
        hostname: "127.0.0.1",
        port: options.port,
        path: options.path,
        headers: { "content-type": "application/json" },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          let json: unknown = null;
          try {
            json = JSON.parse(body);
          } catch {}
          resolve({ statusCode: res.statusCode ?? 0, body, json });
        });
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(options.body));
  });
}

describe("interview refactor regressions", () => {
  it("loads saved interview html with embedded metadata", () => {
    const html = `<!doctype html>
<html><body>
<script id="pi-interview-data" type="application/json">{"title":"Saved","questions":[{"id":"q1","type":"text","question":"Why?"}],"savedAnswers":[{"id":"q1","value":"Because"}],"savedOptionInsights":[{"id":"i1","questionId":"q1","optionKey":"k1","optionText":"opt","prompt":"why","summary":"sum"}],"optionKeysByQuestion":{"q1":["k1"]},"savedAt":"2026-05-04T00:00:00.000Z","wasSubmitted":true,"savedFrom":{"cwd":"~/repo","branch":"main","sessionId":"sid"}}</script>
</body></html>`;

    const result = loadSavedInterview(html, "/tmp/saved-interview.html");

    expect(result.title).toBe("Saved");
    expect(result.savedAnswers).toEqual([{ id: "q1", value: "Because", attachments: undefined }]);
    expect(result.savedOptionInsights).toHaveLength(1);
    expect(result.optionKeysByQuestion).toEqual({ q1: ["k1"] });
    expect(result.wasSubmitted).toBe(true);
  });

  it("returns 400 for malformed submit payloads instead of 404", async () => {
    const handle = await startInterviewServer(
      {
        questions: {
          title: "Interview",
          questions: [{ id: "q1", type: "text", question: "Why?" }],
        },
        sessionToken: "token",
        sessionId: "session-malformed-submit",
        cwd: process.cwd(),
        timeout: 60,
        host: "127.0.0.1",
      },
      { onSubmit() {}, onCancel() {} },
    );

    try {
      const address = handle.server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Server did not expose port");
      }

      const response = await requestJson({
        port: address.port,
        path: "/submit",
        body: { responses: [] },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json).toEqual({ ok: false, error: "Invalid request body" });
    } finally {
      handle.close();
    }
  });

  it("saves snapshots inside snapshot dir and returns snapshot relative path", async () => {
    const cwd = await createTempDir("pi-interview-home-", os.homedir());
    const snapshotDir = await createTempDir("pi-interview-snapshots-");
    const handle = await startInterviewServer(
      {
        questions: { title: "../evil", questions: [{ id: "q1", type: "text", question: "Why?" }] },
        sessionToken: "token",
        sessionId: "session-save-paths",
        cwd,
        timeout: 60,
        host: "127.0.0.1",
        snapshotDir,
      },
      { onSubmit() {}, onCancel() {} },
    );

    try {
      const address = handle.server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Server did not expose port");
      }

      const response = await requestJson({
        port: address.port,
        path: "/save",
        body: { token: "token", responses: [], submitted: false },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json).not.toBeNull();
      const savedPath = String((response.json as Record<string, unknown>).path);
      const relativePath = String((response.json as Record<string, unknown>).relativePath);
      const snapshotRelativePath = relative(snapshotDir, savedPath);
      expect(isAbsolute(snapshotRelativePath)).toBe(false);
      expect(snapshotRelativePath === ".." || snapshotRelativePath.startsWith(`..${sep}`)).toBe(
        false,
      );
      expect(relativePath).toBe(normalizePath(savedPath));
    } finally {
      handle.close();
    }
  });
});
