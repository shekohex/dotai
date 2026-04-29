import { test } from "vitest";

const TEST_TIMEOUT_MS = 15_000;

export const timedTest: typeof test = ((name: string, fn: (...args: any[]) => any) =>
  test(name, { timeout: TEST_TIMEOUT_MS }, fn)) as typeof test;
