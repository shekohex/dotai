import { afterEach, describe, expect, it } from "vitest";
import { loadModeRegistrySync } from "../../src/mode-utils.ts";
import {
  buildBuiltInGsdModes,
  registerBuiltInGsdModes,
  syncBuiltInGsdModes,
  unregisterBuiltInGsdModesForTests,
} from "../../src/extensions/gsd/modes.js";

describe("ensureBuiltInGsdModes", () => {
  afterEach(() => {
    unregisterBuiltInGsdModesForTests();
  });

  it("adds bundled gsd modes through built-in registry", () => {
    registerBuiltInGsdModes();
    const loaded = loadModeRegistrySync();
    expect(loaded.modes["gsd-planner"]).toBeDefined();
    expect(loaded.modes["gsd-executor"]).toBeDefined();
    expect(loaded.currentMode).toBe("build");
  });

  it("exposes built-in GSD modes through canonical registry", () => {
    registerBuiltInGsdModes();
    const loaded = loadModeRegistrySync();

    expect(loaded.modes["gsd-codebase-mapper"]?.provider).toBe("openai-codex");
    expect(loaded.modes["gsd-codebase-mapper"]?.systemPrompt).toContain(
      "You are spawned by `/gsd map-codebase`",
    );
    expect(loaded.modes["gsd-intel-updater"]?.systemPrompt).toContain(
      "You are **gsd-intel-updater**",
    );
  });

  it("keeps bundled gsd modes authoritative", () => {
    registerBuiltInGsdModes();
    const loaded = loadModeRegistrySync();
    expect(loaded.modes["gsd-planner"]?.description).toBe("Built-in GSD planner");
    expect(loaded.modes["gsd-verifier"]).toBeDefined();
  });

  it("syncs bundled gsd modes with enabled state", () => {
    syncBuiltInGsdModes(false);
    expect(loadModeRegistrySync().modes["gsd-planner"]).toBeUndefined();

    syncBuiltInGsdModes(true);
    expect(loadModeRegistrySync().modes["gsd-planner"]).toBeDefined();

    syncBuiltInGsdModes(false);
    expect(loadModeRegistrySync().modes["gsd-planner"]).toBeUndefined();
  });

  it("uses explicit per-role tool sets without glob or grep", () => {
    const built = buildBuiltInGsdModes();

    expect(built.modes["gsd-planner"]?.provider).toBe("openai-codex");
    expect(built.modes["gsd-planner"]?.modelId).toBe("gpt-5.5");
    expect(built.modes["gsd-planner"]?.tools).toEqual(["read", "bash", "websearch", "interview"]);
    expect(built.modes["gsd-planner"]?.tmuxTarget).toBe("window");

    expect(built.modes["gsd-phase-researcher"]?.provider).toBe("openai-codex");
    expect(built.modes["gsd-phase-researcher"]?.modelId).toBe("gpt-5.4-mini");
    expect(built.modes["gsd-phase-researcher"]?.tools).toEqual(["read", "bash", "websearch"]);

    expect(built.modes["gsd-executor"]?.provider).toBe("openai-codex");
    expect(built.modes["gsd-executor"]?.modelId).toBe("gpt-5.5");
    expect(built.modes["gsd-executor"]?.tools).toEqual(["*"]);

    expect(built.modes["gsd-verifier"]?.provider).toBe("openai-codex");
    expect(built.modes["gsd-verifier"]?.modelId).toBe("gpt-5.5");
    expect(built.modes["gsd-verifier"]?.tools).toEqual(["read", "bash", "websearch"]);

    expect(built.modes["gsd-codebase-mapper"]?.provider).toBe("openai-codex");
    expect(built.modes["gsd-codebase-mapper"]?.modelId).toBe("gpt-5.4-mini");
    expect(built.modes["gsd-codebase-mapper"]?.tools).toEqual(["read", "bash", "edit", "write"]);
    expect(built.modes["gsd-codebase-mapper"]?.tmuxTarget).toBe("window");

    expect(built.modes["gsd-intel-updater"]?.provider).toBe("openai-codex");
    expect(built.modes["gsd-intel-updater"]?.modelId).toBe("gpt-5.4-mini");
    expect(built.modes["gsd-intel-updater"]?.tools).toEqual(["read", "bash", "edit", "write"]);
    expect(built.modes["gsd-intel-updater"]?.tmuxTarget).toBe("window");

    expect(built.modes["gsd-debug-session-manager"]?.provider).toBe("openai-codex");
    expect(built.modes["gsd-debug-session-manager"]?.modelId).toBe("gpt-5.5");
    expect(built.modes["gsd-debug-session-manager"]?.tools).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "websearch",
      "subagent",
      "interview",
      "execute",
    ]);

    for (const spec of Object.values(built.modes)) {
      expect(spec.tmuxTarget).toBe("window");
      expect(spec.tools?.includes("glob")).toBeFalsy();
      expect(spec.tools?.includes("grep")).toBeFalsy();
    }
  });
});
