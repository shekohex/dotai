import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Type } from "typebox";
import { Value } from "typebox/value";

import {
  extractChangedFiles,
  resolveCodeNav,
  validateCodeNavRequest,
  type CodeNavRequest,
  type CodeNavRuntime,
} from "../generated/code-nav.js";
import { json } from "./helpers.js";
import type { IncomingMessage, ServerResponse } from "node:http";

const CodeNavRequestSchema = Type.Object({
  symbol: Type.String(),
  filePath: Type.String(),
  line: Type.Number(),
  charStart: Type.Number(),
  side: Type.Union([Type.Literal("old"), Type.Literal("new")]),
  language: Type.Optional(Type.String()),
});

function isValidRelativeFilePath(filePath: string): boolean {
  return filePath.length > 0 && !filePath.includes("..") && !filePath.startsWith("/");
}

async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(
      typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(new Uint8Array(chunk)),
    );
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

const nodeCodeNavRuntime: CodeNavRuntime = {
  runCommand(command, args, options) {
    return new Promise((resolve) => {
      let settled = false;
      const child = spawn(command, args, {
        cwd: options?.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const timeout =
        options?.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              child.kill();
            }, options.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
      child.on("error", () => {
        if (timeout !== undefined) clearTimeout(timeout);
        if (settled) return;
        settled = true;
        resolve({ stdout: "", stderr: "command not found", exitCode: 1 });
      });
      child.on("close", (code) => {
        if (timeout !== undefined) clearTimeout(timeout);
        if (settled) return;
        settled = true;
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          exitCode: code ?? 1,
        });
      });
    });
  },
};

export async function handleCodeNavResolve(args: {
  req: IncomingMessage;
  res: ServerResponse;
  cwd: string;
  currentPatch: string;
}): Promise<void> {
  const body = await parseJsonBody(args.req);
  const validationError = validateCodeNavRequest(body);
  if (validationError !== null) {
    json(args.res, { error: validationError }, 400);
    return;
  }
  if (!Value.Check(CodeNavRequestSchema, body)) {
    json(args.res, { error: "Invalid request body" }, 400);
    return;
  }
  const request: CodeNavRequest = Value.Parse(CodeNavRequestSchema, body);
  const result = await resolveCodeNav(
    nodeCodeNavRuntime,
    request,
    args.cwd,
    extractChangedFiles(args.currentPatch),
  );
  json(args.res, result);
}

export async function handleCodeNavFile(args: {
  res: ServerResponse;
  url: URL;
  cwd: string;
}): Promise<void> {
  const filePath = args.url.searchParams.get("path");
  if (filePath === null || filePath.length === 0) {
    json(args.res, { error: "Missing path" }, 400);
    return;
  }
  if (!isValidRelativeFilePath(filePath)) {
    json(args.res, { error: "Invalid path" }, 400);
    return;
  }
  try {
    const content = await readFile(join(args.cwd, filePath), "utf8");
    json(args.res, { content });
  } catch {
    json(args.res, { error: "File not found" }, 404);
  }
}
