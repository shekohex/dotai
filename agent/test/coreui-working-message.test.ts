import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import {
  startCoreUIWorkingMessageShimmer,
  stopCoreUIWorkingMessageShimmer,
} from "../src/extensions/coreui/working-message.ts";

const TEST_TIMEOUT_MS = 15_000;

const timedTest: typeof test = ((name: string, fn: (...args: unknown[]) => unknown) =>
  test(name, { timeout: TEST_TIMEOUT_MS }, fn)) as typeof test;

afterEach(() => {
  vi.useRealTimers();
});

timedTest("coreui shimmer updates working message and resets cleanly", () => {
  vi.useFakeTimers();

  const messages: Array<string | undefined> = [];
  const fakeContext = {
    ui: {
      setWorkingMessage: (message?: string) => {
        messages.push(message);
      },
    },
  } as unknown as ExtensionContext;

  const interval = startCoreUIWorkingMessageShimmer(fakeContext, "Thinking");

  expect(messages[0]).toContain("\u001B[1;97mT\u001B[22;39m");
  expect(messages[0]).toContain("\u001B[37mh\u001B[22;39m");
  expect(messages[0]).toContain("\u001B[2mi\u001B[22;39m");

  vi.advanceTimersByTime(100);

  expect(messages[1]).toContain("\u001B[1;97mh\u001B[22;39m");

  const result = stopCoreUIWorkingMessageShimmer(interval, fakeContext);

  expect(result).toBeUndefined();
  expect(messages.at(-1)).toBeUndefined();
});
