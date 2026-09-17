// Copyright (c) 2026 Tencent Inc.
// SPDX-License-Identifier: Apache-2.0
// Modified for CubeSandbox Paseo plugin from CubeSandbox v0.7.1.

import { fetch } from "undici";

import type { Sandbox } from "./sandbox.js";
import { createIdleTimeout } from "./stream.js";

export const ENVD_PORT = 49983;
const CONNECT_END_STREAM_FLAG = 0x02;
const CONNECT_COMPRESSED_FLAG = 0x01;
const MAX_CONNECT_ENVELOPE_SIZE = 64 * 1024 * 1024;

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandOptions {
  timeoutMs?: number;
  cwd?: string;
  envs?: Record<string, string>;
  user?: string;
}

function encodeConnectEnvelope(data: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(0, 0);
  header.writeUInt32BE(data.length, 1);
  return Buffer.concat([header, data]);
}

async function* readConnectFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ flags: number; payload: Buffer }> {
  const reader = body.getReader();
  let buffered = Buffer.alloc(0);
  try {
    for (;;) {
      while (buffered.length >= 5) {
        const flags = buffered.readUInt8(0);
        const size = buffered.readUInt32BE(1);
        if (size > MAX_CONNECT_ENVELOPE_SIZE)
          throw new Error("Connect message too large");
        if (buffered.length < size + 5) break;
        yield { flags, payload: buffered.subarray(5, size + 5) };
        buffered = buffered.subarray(size + 5);
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length)
        buffered = Buffer.concat([buffered, Buffer.from(value)]);
    }
  } finally {
    reader.releaseLock();
  }
  if (buffered.length)
    throw new Error("Connect stream ended with a partial message");
}

function raiseConnectEndStream(payload: Buffer): void {
  if (payload.length === 0) return;
  let data: { error?: { code?: string; message?: string } };
  try {
    data = JSON.parse(payload.toString("utf8")) as typeof data;
  } catch {
    return;
  }
  if (!data.error) return;
  const message = data.error.message?.trim() || "Connect stream error";
  throw new Error(data.error.code ? `${data.error.code}: ${message}` : message);
}

function exitCodeFromStatus(status: unknown): number | null {
  if (typeof status !== "string") return null;
  const exitMatch = status.match(/(?:exit status|exited with code)\s+(-?\d+)/);
  if (exitMatch?.[1]) return Number.parseInt(exitMatch[1], 10);
  const signalMatch = status.match(/(?:signal|terminated by signal)\s+(\d+)/);
  if (signalMatch?.[1]) return 128 + Number.parseInt(signalMatch[1], 10);
  return status === "exited" ? 0 : null;
}

export class Commands {
  constructor(private readonly sandbox: Sandbox) {}

  async run(
    command: string,
    options: CommandOptions = {},
  ): Promise<CommandResult> {
    const user = options.user ?? "root";
    const headers: Record<string, string> = {
      "Content-Type": "application/connect+json",
      "Connect-Protocol-Version": "1",
      "Connect-Content-Encoding": "identity",
      Authorization: `Basic ${Buffer.from(`${user}:`).toString("base64")}`,
      ...this.sandbox.trafficTokenHeaders(),
    };
    if (options.timeoutMs && options.timeoutMs > 0) {
      headers["Connect-Timeout-Ms"] = String(Math.trunc(options.timeoutMs));
    }
    if (this.sandbox.envdAccessToken)
      headers["X-Access-Token"] = this.sandbox.envdAccessToken;
    const payload = {
      process: {
        cmd: "/bin/bash",
        args: ["-l", "-c", command],
        envs: options.envs ?? {},
        ...(options.cwd ? { cwd: options.cwd } : {}),
      },
      stdin: false,
    };
    const timeout = createIdleTimeout(options.timeoutMs);
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(
        this.sandbox.dataUrl(ENVD_PORT, "/process.Process/Start"),
        {
          method: "POST",
          headers,
          body: encodeConnectEnvelope(Buffer.from(JSON.stringify(payload))),
          dispatcher: this.sandbox.dataDispatcher,
          signal: timeout.signal,
        },
      );
    } catch (error) {
      if (timeout.firedRef.current)
        throw new Error(`command timed out after ${options.timeoutMs}ms`);
      throw error;
    }
    if (response.status >= 400) {
      const detail = (await response.text().catch(() => "")).trim();
      throw new Error(
        `command failed: HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      );
    }
    if (!response.body)
      throw new Error("process stream ended without EndEvent");

    const stdout: string[] = [];
    const stderr: string[] = [];
    let exitCode: number | null = null;
    try {
      for await (const { flags, payload: frame } of readConnectFrames(
        response.body as ReadableStream<Uint8Array>,
      )) {
        timeout.reset();
        if (flags & CONNECT_COMPRESSED_FLAG)
          throw new Error("Unsupported compressed Connect message");
        if (flags & CONNECT_END_STREAM_FLAG) {
          raiseConnectEndStream(frame);
          break;
        }
        const event = JSON.parse(frame.toString("utf8")).event ?? {};
        if (event.data?.stdout)
          stdout.push(
            Buffer.from(event.data.stdout, "base64").toString("utf8"),
          );
        if (event.data?.stderr)
          stderr.push(
            Buffer.from(event.data.stderr, "base64").toString("utf8"),
          );
        if (event.end !== undefined && event.end !== null) {
          if (event.end.exitCode !== undefined)
            exitCode = Number(event.end.exitCode);
          else if (event.end.exit_code !== undefined)
            exitCode = Number(event.end.exit_code);
          else if (exitCodeFromStatus(event.end.status) !== null)
            exitCode = exitCodeFromStatus(event.end.status);
          else if (event.end.error)
            throw new Error(`process failed: ${event.end.error}`);
          else if (event.end.exited) exitCode = 0;
          else throw new Error("process EndEvent missing exit code");
        }
      }
    } finally {
      timeout.clear();
    }
    if (exitCode === null)
      throw new Error("process stream ended without EndEvent");
    return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode };
  }
}
