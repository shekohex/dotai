// Copyright (c) 2026 Tencent Inc.
// SPDX-License-Identifier: Apache-2.0
// Modified for CubeSandbox Paseo plugin from CubeSandbox v0.7.1.

import { Agent, buildConnector, fetch, Headers, type Dispatcher } from "undici";

import type { Config } from "./config.js";

export function buildDataDispatcher(config: Config): Dispatcher | undefined {
  if (!config.proxyNodeIp) return undefined;
  const baseConnect = buildConnector({ timeout: config.requestTimeoutMs });
  return new Agent({
    connect(options, callback) {
      const virtualServername =
        (options as { servername?: string }).servername ??
        (typeof options.hostname === "string" ? options.hostname : undefined);
      baseConnect(
        {
          ...options,
          hostname: config.proxyNodeIp!,
          port: String(config.proxyPort),
          servername: virtualServername,
        },
        callback,
      );
    },
  });
}

export function controlFetch(
  config: Config,
  url: string,
  init: Parameters<typeof fetch>[1] = {},
): ReturnType<typeof fetch> {
  const headers = new Headers(init?.headers);
  if (config.apiKey && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${config.apiKey}`);
  }
  const controller = init?.signal ? undefined : new AbortController();
  const timeout = controller
    ? setTimeout(() => controller.abort(), config.requestTimeoutMs)
    : undefined;
  const request = fetch(url, {
    ...init,
    headers,
    signal: init?.signal ?? controller?.signal,
  });
  return request.finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}
