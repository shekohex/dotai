import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  handleCodeNavFile,
  handleCodeNavResolve,
} from "../src/extensions/plannotator/server/review-code-nav.ts";

type JsonResponse = {
  statusCode: number;
  headers: Record<string, string | number | readonly string[]>;
  body: unknown;
};

function createJsonRequest(value: unknown): PassThrough {
  const req = new PassThrough() as PassThrough & { method?: string; url?: string };
  req.end(JSON.stringify(value));
  return req;
}

function createJsonResponse(): {
  response: JsonResponse;
  res: {
    writeHead: (status: number, headers: Record<string, string>) => void;
    end: (chunk: string) => void;
  };
} {
  const response: JsonResponse = { statusCode: 200, headers: {}, body: undefined };
  return {
    response,
    res: {
      writeHead(status, headers) {
        response.statusCode = status;
        response.headers = headers;
      },
      end(chunk) {
        response.body = JSON.parse(chunk);
      },
    },
  };
}

async function callResolve(body: unknown, cwd: string): Promise<JsonResponse> {
  const { response, res } = createJsonResponse();
  await handleCodeNavResolve({
    req: createJsonRequest(body) as never,
    res: res as never,
    cwd,
    currentPatch: "diff --git a/src/app.ts b/src/app.ts\n",
  });
  return response;
}

async function callFile(path: string | null, cwd: string): Promise<JsonResponse> {
  const { response, res } = createJsonResponse();
  const url = new URL("http://localhost/api/code-nav/file");
  if (path !== null) url.searchParams.set("path", path);
  await handleCodeNavFile({ res: res as never, url, cwd });
  return response;
}

describe("plannotator code navigation routes", () => {
  let cwd: string | undefined;

  afterEach(async () => {
    if (cwd !== undefined) {
      await rm(cwd, { recursive: true, force: true });
      cwd = undefined;
    }
  });

  async function createRepoFixture(): Promise<string> {
    cwd = await mkdtemp(join(tmpdir(), "plannotator-code-nav-"));
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(
      join(cwd, "src", "app.ts"),
      ["export function demoSymbol() {", "  return 1;", "}", "demoSymbol();"].join("\n"),
      "utf8",
    );
    return cwd;
  }

  it("matches upstream validation errors for malformed resolve requests", async () => {
    const fixture = await createRepoFixture();

    await expect(callResolve(null, fixture)).resolves.toMatchObject({
      statusCode: 400,
      body: { error: "Invalid request body" },
    });
    await expect(callResolve({}, fixture)).resolves.toMatchObject({
      statusCode: 400,
      body: { error: "Missing or empty symbol" },
    });
    await expect(callResolve({ symbol: "x" }, fixture)).resolves.toMatchObject({
      statusCode: 400,
      body: { error: "Missing filePath" },
    });
    await expect(
      callResolve({ symbol: "x", filePath: "../app.ts", side: "new" }, fixture),
    ).resolves.toMatchObject({
      statusCode: 400,
      body: { error: "Invalid filePath" },
    });
    await expect(
      callResolve({ symbol: "x", filePath: "src/app.ts", side: "both" }, fixture),
    ).resolves.toMatchObject({
      statusCode: 400,
      body: { error: "side must be 'old' or 'new'" },
    });
  });

  it("returns upstream-compatible code navigation results", async () => {
    const fixture = await createRepoFixture();

    const response = await callResolve(
      {
        symbol: "demoSymbol",
        filePath: "src/app.ts",
        line: 4,
        charStart: 0,
        side: "new",
        language: "typescript",
      },
      fixture,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ backend: expect.any(String), searchScope: "head" });
    if ((response.body as { backend: string }).backend === "search") {
      expect((response.body as { definitions: unknown[] }).definitions.length).toBeGreaterThan(0);
      expect(response.body).toMatchObject({ complete: true });
    }
  });

  it("matches upstream file preview status codes", async () => {
    const fixture = await createRepoFixture();

    await expect(callFile(null, fixture)).resolves.toMatchObject({
      statusCode: 400,
      body: { error: "Missing path" },
    });
    await expect(callFile("../app.ts", fixture)).resolves.toMatchObject({
      statusCode: 400,
      body: { error: "Invalid path" },
    });
    await expect(callFile("src/missing.ts", fixture)).resolves.toMatchObject({
      statusCode: 404,
      body: { error: "File not found" },
    });

    const response = await callFile("src/app.ts", fixture);
    expect(response.statusCode).toBe(200);
    expect((response.body as { content: string }).content).toBe(
      await readFile(join(fixture, "src", "app.ts"), "utf8"),
    );
  });
});
