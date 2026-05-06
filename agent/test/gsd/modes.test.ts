import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadModeRegistrySync, loadModesFileSync } from "../../src/mode-utils.ts";
import {
  buildBuiltInGsdModes,
  registerBuiltInGsdModes,
  unregisterBuiltInGsdModesForTests,
} from "../../src/extensions/gsd/modes.js";

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-gsd-modes-"));
  mkdirSync(join(root, ".pi"), { recursive: true });
  return root;
}

describe("ensureBuiltInGsdModes", () => {
  afterEach(() => {
    unregisterBuiltInGsdModesForTests();
  });

  it("adds bundled gsd modes through built-in registry", () => {
    const root = createRoot();
    registerBuiltInGsdModes();
    const loaded = loadModesFileSync(root);
    expect(loaded.data.modes["gsd-planner"]).toBeDefined();
    expect(loaded.data.modes["gsd-executor"]).toBeDefined();
  });

  it("exposes built-in GSD modes through canonical registry", () => {
    const root = createRoot();
    registerBuiltInGsdModes();
    const loaded = loadModeRegistrySync(root);

    expect(loaded.data.modes["gsd-codebase-mapper"]?.provider).toBe("codex-openai");
    expect(loaded.resolvedData.modes["gsd-codebase-mapper"]?.systemPrompt).toContain(
      "You are spawned by `/gsd map-codebase`",
    );
  });

  it("keeps bundled gsd modes authoritative", () => {
    const root = createRoot();
    registerBuiltInGsdModes();
    const loaded = loadModesFileSync(root);
    expect(loaded.data.modes["gsd-planner"]?.description).toBe("Built-in GSD planner");
    expect(loaded.data.modes["gsd-verifier"]).toBeDefined();
  });

  it("uses explicit per-role tool sets without glob or grep", () => {
    const built = buildBuiltInGsdModes();

    expect(built.modes["gsd-planner"]?.provider).toBe("codex-openai");
    expect(built.modes["gsd-planner"]?.modelId).toBe("gpt-5.5");
    expect(built.modes["gsd-planner"]?.tools).toEqual(["read", "bash", "websearch", "interview"]);

    expect(built.modes["gsd-phase-researcher"]?.provider).toBe("codex-openai");
    expect(built.modes["gsd-phase-researcher"]?.modelId).toBe("gpt-5.4-mini");
    expect(built.modes["gsd-phase-researcher"]?.tools).toEqual(["read", "bash", "websearch"]);

    expect(built.modes["gsd-executor"]?.provider).toBe("codex-openai");
    expect(built.modes["gsd-executor"]?.modelId).toBe("gpt-5.5");
    expect(built.modes["gsd-executor"]?.tools).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "websearch",
      "execute",
    ]);

    expect(built.modes["gsd-verifier"]?.provider).toBe("codex-openai");
    expect(built.modes["gsd-verifier"]?.modelId).toBe("gpt-5.5");
    expect(built.modes["gsd-verifier"]?.tools).toEqual(["read", "bash", "websearch"]);

    expect(built.modes["gsd-codebase-mapper"]?.provider).toBe("codex-openai");
    expect(built.modes["gsd-codebase-mapper"]?.modelId).toBe("gpt-5.4-mini");
    expect(built.modes["gsd-codebase-mapper"]?.tools).toEqual(["read", "bash", "edit", "write"]);
    expect(built.modes["gsd-codebase-mapper"]?.tmuxTarget).toBe("window");

    expect(built.modes["gsd-debug-session-manager"]?.provider).toBe("codex-openai");
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
