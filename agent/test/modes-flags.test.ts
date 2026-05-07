import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  registerBuiltInGsdModes,
  unregisterBuiltInGsdModesForTests,
} from "../src/extensions/gsd/modes.js";
import { registerModeFlags, subscribeModeFlagRefresh } from "../src/extensions/modes/flags.js";

function createRoot(): string {
  return mkdtempSync(join(tmpdir(), "agent-modes-flags-"));
}

class FakePi {
  flags = new Map<string, { description: string; type: string }>();

  registerFlag(name: string, definition: { description: string; type: string }): void {
    this.flags.set(name, definition);
  }
}

describe("registerModeFlags", () => {
  const previousCwd = process.cwd();

  afterEach(() => {
    process.chdir(previousCwd);
    unregisterBuiltInGsdModesForTests();
  });

  it("registers built-in GSD startup flags from canonical mode registry", () => {
    const root = createRoot();
    mkdirSync(join(root, ".pi"), { recursive: true });
    process.chdir(root);
    registerBuiltInGsdModes();

    const pi = new FakePi();
    const registeredModeFlags = new Map<string, string>();

    registerModeFlags(
      pi as unknown as Parameters<typeof registerModeFlags>[0],
      registeredModeFlags,
      {
        orderedModeNames: (data) =>
          Object.keys(data.modes).toSorted((left, right) => left.localeCompare(right)),
        describeModeSpec: (spec) => spec?.description,
        hasText: (value): value is string => value !== undefined && value.length > 0,
      },
    );

    expect(registeredModeFlags.get("mode-gsd-codebase-mapper")).toBe("gsd-codebase-mapper");
    expect(pi.flags.get("mode-gsd-codebase-mapper")?.description).toContain(
      'Start in "gsd-codebase-mapper" mode',
    );
  });

  it("refreshes registered flags when GSD built-in modes register after modes init", () => {
    const root = createRoot();
    mkdirSync(join(root, ".pi"), { recursive: true });
    process.chdir(root);

    const pi = new FakePi();
    const registeredModeFlags = new Map<string, string>();
    const unregisterRefresh = subscribeModeFlagRefresh(() => {
      registerModeFlags(
        pi as unknown as Parameters<typeof registerModeFlags>[0],
        registeredModeFlags,
        {
          orderedModeNames: (data) =>
            Object.keys(data.modes).toSorted((left, right) => left.localeCompare(right)),
          describeModeSpec: (spec) => spec?.description,
          hasText: (value): value is string => value !== undefined && value.length > 0,
        },
      );
    });

    registerModeFlags(
      pi as unknown as Parameters<typeof registerModeFlags>[0],
      registeredModeFlags,
      {
        orderedModeNames: (data) =>
          Object.keys(data.modes).toSorted((left, right) => left.localeCompare(right)),
        describeModeSpec: (spec) => spec?.description,
        hasText: (value): value is string => value !== undefined && value.length > 0,
      },
    );
    expect(registeredModeFlags.get("mode-gsd-codebase-mapper")).toBeUndefined();

    registerBuiltInGsdModes();

    expect(registeredModeFlags.get("mode-gsd-codebase-mapper")).toBe("gsd-codebase-mapper");
    expect(pi.flags.get("mode-gsd-codebase-mapper")?.description).toContain(
      'Start in "gsd-codebase-mapper" mode',
    );

    unregisterRefresh();
  });
});
