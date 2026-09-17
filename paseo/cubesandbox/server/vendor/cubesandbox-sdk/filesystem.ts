// Copyright (c) 2026 Tencent Inc.
// SPDX-License-Identifier: Apache-2.0
// Modified for CubeSandbox Paseo plugin from CubeSandbox v0.7.1.

import { fetch } from "undici";

import type { Sandbox } from "./sandbox.js";

const ENVD_PORT = 49983;

function toBuffer(data: string | Uint8Array): Buffer {
  return typeof data === "string"
    ? Buffer.from(data, "utf8")
    : Buffer.from(data);
}

export class Filesystem {
  constructor(private readonly sandbox: Sandbox) {}

  private baseHeaders(): Record<string, string> {
    const headers = this.sandbox.trafficTokenHeaders();
    if (this.sandbox.envdAccessToken) {
      headers["X-Access-Token"] = this.sandbox.envdAccessToken;
    }
    return headers;
  }

  async write(
    path: string,
    data: string | Uint8Array,
    options: { user?: string } = {},
  ): Promise<void> {
    const user = options.user ?? "root";
    const params = new URLSearchParams({ path, username: user });
    const url = this.sandbox.dataUrl(ENVD_PORT, `/files?${params.toString()}`);
    const body = toBuffer(data);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...this.baseHeaders(),
        "Content-Type": "application/octet-stream",
      },
      body,
      dispatcher: this.sandbox.dataDispatcher,
    });
    if (response.status >= 400) {
      const detail = (await response.text().catch(() => "")).trim();
      throw new Error(
        `Failed to write ${path}: ${detail || `HTTP ${response.status}`}`,
      );
    }
  }
}
