import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

  it("exposes built-in and file-backed modes through canonical registry", () => {
    const root = createRoot();
    writeFileSync(
      join(root, ".pi", "modes.json"),
      `${JSON.stringify(
        {
          version: 1,
          currentMode: "custom-mode",
          modes: {
            "custom-mode": {
              description: "mine",
              systemPrompt: "keep me",
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    registerBuiltInGsdModes();
    const loaded = loadModeRegistrySync(root);

    expect(loaded.data.currentMode).toBe("custom-mode");
    expect(loaded.data.modes["custom-mode"]?.systemPrompt).toBe("keep me");
    expect(loaded.data.modes["gsd-codebase-mapper"]?.provider).toBe("codex-openai");
    expect(loaded.resolvedData.modes["gsd-codebase-mapper"]?.systemPrompt).toContain(
      "You are spawned by `/gsd map-codebase`",
    );
  });

  it("preserves existing project modes without overriding them", () => {
    const root = createRoot();
    writeFileSync(
      join(root, ".pi", "modes.json"),
      `${JSON.stringify(
        {
          version: 1,
          currentMode: "custom-mode",
          modes: {
            "custom-mode": {
              description: "mine",
              systemPrompt: "keep me",
            },
            "gsd-planner": {
              description: "user override",
              systemPrompt: "user prompt",
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    registerBuiltInGsdModes();
    const loaded = loadModesFileSync(root);
    expect(loaded.data.currentMode).toBe("custom-mode");
    expect(loaded.data.modes["gsd-planner"]?.description).toBe("user override");
    expect(loaded.data.modes["custom-mode"]?.systemPrompt).toBe("keep me");
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

    for (const spec of Object.values(built.modes)) {
      expect(spec.tools?.includes("glob")).toBeFalsy();
      expect(spec.tools?.includes("grep")).toBeFalsy();
    }
  });
});
