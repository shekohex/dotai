// Copyright (c) 2026 Tencent Inc.
// SPDX-License-Identifier: Apache-2.0
// Modified for CubeSandbox Paseo plugin from CubeSandbox v0.7.1.

import type { Dispatcher } from "undici";

import { Commands } from "./commands.js";
import { Config, resolveConfig, type ConfigOptions } from "./config.js";
import { Filesystem } from "./filesystem.js";
import {
  ApiError,
  AuthenticationError,
  SandboxNotFoundError,
  TemplateNotFoundError,
} from "./exceptions.js";
import { buildDataDispatcher, controlFetch } from "./transport.js";

export interface CreateOptions {
  template: string;
  timeout?: number;
  envVars?: Record<string, string>;
  metadata?: Record<string, string>;
  lifecycle?: { onTimeout?: "kill" | "pause"; autoResume?: boolean };
  config?: Config | ConfigOptions;
}

export interface PauseOptions {
  wait?: boolean;
  timeoutMs?: number;
  intervalMs?: number;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function checkControlResponse(response: {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}): Promise<void> {
  if (response.ok) return;
  const detail = (await response.text().catch(() => "")).trim().slice(0, 500);
  const message = detail || `HTTP ${response.status}`;
  if (response.status === 401 || response.status === 403) {
    throw new AuthenticationError(message, response.status);
  }
  if (response.status === 404) {
    if (message.toLowerCase().includes("template")) {
      throw new TemplateNotFoundError(message, response.status);
    }
    throw new SandboxNotFoundError(message, response.status);
  }
  throw new ApiError(message, response.status);
}

export class Sandbox {
  readonly commands: Commands;
  readonly files: Filesystem;
  private dispatcher: Dispatcher | undefined;

  constructor(
    private readonly data: Record<string, unknown>,
    readonly config: Config,
  ) {
    this.commands = new Commands(this);
    this.files = new Filesystem(this);
  }

  get sandboxId(): string {
    return String(this.data.sandboxID ?? "");
  }

  get domain(): string {
    return String(this.data.domain ?? this.config.sandboxDomain);
  }

  get responseDomain(): string | undefined {
    const value = this.data.domain;
    return typeof value === "string" ? value : undefined;
  }

  get envdAccessToken(): string | undefined {
    const value = this.data.envdAccessToken;
    return typeof value === "string" ? value : undefined;
  }

  get dataDispatcher(): Dispatcher | undefined {
    this.dispatcher ??= buildDataDispatcher(this.config);
    return this.dispatcher;
  }

  dataUrl(port: number, requestPath: string): string {
    return `${this.config.proxyScheme}://${port}-${this.sandboxId}.${this.domain}${requestPath}`;
  }

  trafficTokenHeaders(): Record<string, string> {
    const value = this.data.trafficAccessToken;
    return typeof value === "string" && value
      ? {
          "e2b-traffic-access-token": value,
          "cube-traffic-access-token": value,
        }
      : {};
  }

  static async create(options: CreateOptions): Promise<Sandbox> {
    const config = resolveConfig(options.config);
    const response = await controlFetch(config, `${config.apiUrl}/sandboxes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateID: options.template,
        ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
        ...(options.envVars ? { envVars: options.envVars } : {}),
        ...(options.metadata ? { metadata: options.metadata } : {}),
        ...(options.lifecycle ? { lifecycle: options.lifecycle } : {}),
      }),
    });
    await checkControlResponse(response);
    return new Sandbox(
      (await response.json()) as Record<string, unknown>,
      config,
    );
  }

  static async connect(
    sandboxId: string,
    options: { config?: Config | ConfigOptions } = {},
  ): Promise<Sandbox> {
    const config = resolveConfig(options.config);
    const response = await controlFetch(
      config,
      `${config.apiUrl}/sandboxes/${sandboxId}/connect`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    await checkControlResponse(response);
    return new Sandbox(
      (await response.json()) as Record<string, unknown>,
      config,
    );
  }

  static async listSnapshots(
    options: { limit?: number; config?: Config | ConfigOptions } = {},
  ): Promise<Record<string, unknown>[]> {
    const config = resolveConfig(options.config);
    const query = options.limit ? `?limit=${options.limit}` : "";
    const response = await controlFetch(
      config,
      `${config.apiUrl}/snapshots${query}`,
    );
    await checkControlResponse(response);
    return (await response.json()) as Record<string, unknown>[];
  }

  async getInfo(): Promise<Record<string, unknown>> {
    const response = await controlFetch(
      this.config,
      `${this.config.apiUrl}/sandboxes/${this.sandboxId}`,
    );
    await checkControlResponse(response);
    return (await response.json()) as Record<string, unknown>;
  }

  async pause(options: PauseOptions = {}): Promise<void> {
    const wait = options.wait ?? true;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const intervalMs = options.intervalMs ?? 1_000;
    const response = await controlFetch(
      this.config,
      `${this.config.apiUrl}/sandboxes/${this.sandboxId}/pause`,
      { method: "POST" },
    );
    await checkControlResponse(response);
    if (!wait) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.getInfo()).state === "paused") return;
      await sleep(intervalMs);
    }
    throw new Error(
      `Sandbox ${this.sandboxId} did not reach 'paused' state within ${timeoutMs}ms`,
    );
  }

  async kill(): Promise<void> {
    const response = await controlFetch(
      this.config,
      `${this.config.apiUrl}/sandboxes/${this.sandboxId}`,
      { method: "DELETE" },
    );
    await checkControlResponse(response);
  }
}
