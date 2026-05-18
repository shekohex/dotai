import { afterEach, describe, expect, it } from "vitest";
import { loadModeRegistrySync } from "../../src/mode-utils.ts";
import {
  buildBuiltInGsdModes,
  registerBuiltInGsdModes,
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

  it("uses explicit per-role tool sets without glob or grep", () => {
    const built = buildBuiltInGsdModes();

    expect(built.modes["gsd-planner"]?.provider).toBe("openai-codex");
    expect(built.modes["gsd-planner"]?.modelId).toBe("gpt-5.5");
    expect(built.modes["gsd-planner"]?.tools).toEqual(["read", "bash", "websearch", "interview"]);

    expect(built.modes["gsd-phase-researcher"]?.provider).toBe("openai-codex");
    expect(built.modes["gsd-phase-researcher"]?.modelId).toBe("gpt-5.4-mini");
    expect(built.modes["gsd-phase-researcher"]?.tools).toEqual(["read", "bash", "websearch"]);

    expect(built.modes["gsd-executor"]?.provider).toBe("openai-codex");
    expect(built.modes["gsd-executor"]?.modelId).toBe("gpt-5.5");
    expect(built.modes["gsd-executor"]?.tools).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "websearch",
      "execute",
    ]);

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
      expect(spec.tools?.includes("glob")).toBeFalsy();
      expect(spec.tools?.includes("grep")).toBeFalsy();
    }
  });
});
