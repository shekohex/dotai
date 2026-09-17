// Copyright (c) 2026 Tencent Inc.
// SPDX-License-Identifier: Apache-2.0
// Modified for CubeSandbox Paseo plugin from CubeSandbox v0.7.1.

export interface ConfigOptions {
  apiUrl?: string;
  apiKey?: string | null;
  proxyNodeIp?: string | null;
  proxyPort?: number;
  proxyScheme?: string;
  sandboxDomain?: string;
  timeout?: number;
  requestTimeoutMs?: number;
}

export class Config {
  apiUrl: string;
  apiKey: string | null;
  proxyNodeIp: string | null;
  proxyPort: number;
  proxyScheme: string;
  sandboxDomain: string;
  timeout: number;
  requestTimeoutMs: number;

  constructor(options: ConfigOptions = {}) {
    this.apiUrl = (
      options.apiUrl ??
      process.env.CUBE_API_URL ??
      "http://127.0.0.1:3000"
    ).replace(/\/+$/, "");
    const rawKey = options.apiKey ?? process.env.CUBE_API_KEY ?? null;
    this.apiKey = rawKey && rawKey.trim() ? rawKey.trim() : null;
    this.proxyNodeIp =
      options.proxyNodeIp ?? process.env.CUBE_PROXY_NODE_IP ?? null;
    this.proxyPort = options.proxyPort ?? 443;
    this.proxyScheme = options.proxyScheme ?? "https";
    this.sandboxDomain = options.sandboxDomain ?? "cube.app";
    this.timeout = options.timeout ?? 300;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }
}

export function resolveConfig(config?: Config | ConfigOptions): Config {
  return config instanceof Config ? config : new Config(config);
}
