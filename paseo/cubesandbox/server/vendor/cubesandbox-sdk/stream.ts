// Copyright (c) 2026 Tencent Inc.
// SPDX-License-Identifier: Apache-2.0
// Modified for CubeSandbox Paseo plugin from CubeSandbox v0.7.1.

export function createIdleTimeout(timeoutMs: number | undefined): {
  signal: AbortSignal | undefined;
  firedRef: { current: boolean };
  reset: () => void;
  clear: () => void;
} {
  if (timeoutMs === undefined || timeoutMs <= 0) {
    return {
      signal: undefined,
      firedRef: { current: false },
      reset: () => undefined,
      clear: () => undefined,
    };
  }
  const controller = new AbortController();
  const firedRef = { current: false };
  let timer: NodeJS.Timeout;
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      firedRef.current = true;
      controller.abort();
    }, timeoutMs);
  };
  reset();
  return {
    signal: controller.signal,
    firedRef,
    reset,
    clear: () => clearTimeout(timer),
  };
}
