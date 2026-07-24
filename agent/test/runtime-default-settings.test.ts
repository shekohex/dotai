import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { describe, expect, it } from "vitest";

import {
  ensureRuntimeDefaultSettings,
  mergeMissingDefaults,
} from "../src/runtime-default-settings.js";

describe("runtime default settings", () => {
  it("fills missing defaults while preserving user preferences", () => {
    expect(
      mergeMissingDefaults(
        {
          defaultModel: "gpt-5.5",
          retry: { enabled: true, maxRetries: 1024 },
          terminal: { showImages: true, titleSpinner: true },
          tools: ["default"],
        },
        {
          defaultModel: "custom-model",
          retry: { maxRetries: 3 },
          terminal: false,
          customKey: "kept",
        },
      ),
    ).toEqual({
      mergedSettings: {
        defaultModel: "custom-model",
        retry: { maxRetries: 3, enabled: true },
        terminal: false,
        customKey: "kept",
        tools: ["default"],
      },
      changed: true,
    });
  });

  it("keeps unknown keys and does not overwrite existing values", () => {
    expect(
      mergeMissingDefaults(
        {
          theme: "new-default-theme",
          retry: { enabled: true, maxRetries: 1024 },
        },
        {
          theme: "user-theme",
          retry: { enabled: false, deprecatedRetryKey: 10 },
          deprecatedTopLevelKey: "kept",
        },
      ),
    ).toEqual({
      mergedSettings: {
        theme: "user-theme",
        retry: { enabled: false, deprecatedRetryKey: 10, maxRetries: 1024 },
        deprecatedTopLevelKey: "kept",
      },
      changed: true,
    });
  });

  it("does not rewrite settings when no defaults are missing", () => {
    expect(
      mergeMissingDefaults(
        { theme: "default-theme", retry: { enabled: true } },
        { theme: "user-theme", retry: { enabled: false } },
      ),
    ).toEqual({
      mergedSettings: { theme: "user-theme", retry: { enabled: false } },
      changed: false,
    });
  });

  it("creates settings file from bundled defaults when missing", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-runtime-settings-"));
    const settingsPath = join(tempDir, "settings.json");

    try {
      await expect(ensureRuntimeDefaultSettings(settingsPath)).resolves.toBe(true);

      expect(JSON.parse(await readFile(settingsPath, "utf8"))).toMatchObject({
        defaultProvider: "openai-codex",
        theme: "catppuccin-mocha",
        retry: { enabled: true, maxRetries: 1024 },
        subagents: { enabled: false },
        live: {
          enabled: true,
          identity: { firstName: "Shady", lastName: "Khalifa", username: "shekohex" },
          voice: "onyx",
          transport: "coder",
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("merges bundled defaults into existing settings at runtime", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-runtime-settings-"));
    const settingsPath = join(tempDir, "settings.json");

    try {
      await writeFile(
        settingsPath,
        `${JSON.stringify({ defaultModel: "local", retry: { maxRetries: 2 } })}\n`,
        "utf8",
      );

      await expect(ensureRuntimeDefaultSettings(settingsPath)).resolves.toBe(true);

      expect(JSON.parse(await readFile(settingsPath, "utf8"))).toMatchObject({
        defaultProvider: "openai-codex",
        defaultModel: "local",
        retry: { enabled: true, maxRetries: 2 },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves upstream legacy websocket migration before merging defaults", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-runtime-settings-"));
    const settingsPath = join(tempDir, "settings.json");

    try {
      await writeFile(settingsPath, `${JSON.stringify({ websockets: true })}\n`, "utf8");

      await expect(ensureRuntimeDefaultSettings(settingsPath)).resolves.toBe(true);

      expect(JSON.parse(await readFile(settingsPath, "utf8"))).toMatchObject({
        transport: "websocket",
      });
      expect(JSON.parse(await readFile(settingsPath, "utf8"))).not.toHaveProperty("websockets");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips malformed settings so upstream startup can report diagnostics", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-runtime-settings-"));
    const settingsPath = join(tempDir, "settings.json");

    try {
      await writeFile(settingsPath, "{", "utf8");

      await expect(ensureRuntimeDefaultSettings(settingsPath)).resolves.toBe(false);

      expect(await readFile(settingsPath, "utf8")).toBe("{");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips unreadable settings so upstream startup can report diagnostics", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-runtime-settings-"));
    const settingsPath = join(tempDir, "settings.json");

    try {
      await mkdir(settingsPath);

      await expect(ensureRuntimeDefaultSettings(settingsPath)).resolves.toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not replace unreadable existing settings with defaults", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-runtime-settings-"));
    const settingsPath = join(tempDir, "settings.json");

    try {
      await writeFile(settingsPath, `${JSON.stringify({ defaultModel: "local" })}\n`, "utf8");
      await chmod(settingsPath, 0o200);

      await expect(ensureRuntimeDefaultSettings(settingsPath)).resolves.toBe(false);

      await chmod(settingsPath, 0o600);
      expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({ defaultModel: "local" });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("respects settings lock before creating a missing settings file", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-runtime-settings-"));
    const settingsPath = join(tempDir, "settings.json");
    const releaseLock = await lockfile.lock(settingsPath, { realpath: false });

    try {
      await expect(ensureRuntimeDefaultSettings(settingsPath)).resolves.toBe(false);
    } finally {
      await releaseLock();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
