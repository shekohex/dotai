import { describe, expect, test, vi } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import {
  getEditorTheme,
  theme as activeTheme,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import {
  buildFimContext,
  buildFimPrompt,
  buildSystemPrompt,
  createPiAiAutocompleteBackend,
  buildZetaNextEditPrompt,
  DebouncedAiAutocompleteRunner,
  normalizeCompletion,
} from "../src/extensions/coreui/ai-autocomplete-backend.js";
import {
  defaultAiAutocompleteSettings,
  parseAiAutocompleteSettings,
  saveAiAutocompleteSettings,
} from "../src/extensions/coreui/ai-autocomplete-settings.js";
import { createCorePromptEditorFactory } from "../src/extensions/coreui/editor.js";

describe("coreui ai autocomplete backend", () => {
  test("defaults enable eager autocomplete", () => {
    expect(defaultAiAutocompleteSettings.enabled).toBe(true);
    expect(defaultAiAutocompleteSettings.mode).toBe("lazy");
  });

  test("invalid settings fail closed with warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(
        parseAiAutocompleteSettings({
          enabled: false,
          models: "local-cpu/foo",
          debounceMs: "350",
        }),
      ).toMatchObject({ enabled: false, models: [] });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("saving refuses malformed top-level settings", async () => {
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = mkdtempSync(join(tmpdir(), "agent-ai-autocomplete-settings-"));
    try {
      process.env.PI_CODING_AGENT_DIR = agentDir;
      const settingsPath = join(agentDir, "settings.json");
      writeFileSync(settingsPath, "[]\n", "utf-8");

      await expect(saveAiAutocompleteSettings(defaultAiAutocompleteSettings)).rejects.toThrow(
        /JSON object/u,
      );
      expect(readFileSync(settingsPath, "utf-8")).toBe("[]\n");
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });

  test("builds bounded FIM context around cursor", () => {
    const context = buildFimContext(
      {
        text: "alpha beta gamma delta",
        cursorOffset: "alpha beta".length,
        cwd: "/repo",
        signal: new AbortController().signal,
      },
      { maxPrefixChars: 4, maxSuffixChars: 6, maxAssistantSummaryChars: 2000 },
    );

    expect(context).toEqual({ prefix: "beta", suffix: " gamma", cwd: "/repo" });
  });

  test("builds generic chat FIM prompt", () => {
    expect(buildFimPrompt({ prefix: "hello ", suffix: " world", cwd: "/repo" })).toContain(
      "<prefix>\nhello \n</prefix>\n<cursor>\n<suffix>\n world\n</suffix>",
    );
  });

  test("builds zeta-style next edit prompt", () => {
    expect(
      buildZetaNextEditPrompt({
        prefix: "hello ",
        suffix: " world",
        cwd: "/repo",
        assistantSummary: "User prefers concise output.",
      }),
    ).toContain("Previous assistant/session summary");
  });

  test("system prompt tells backend not to answer questions", () => {
    expect(buildSystemPrompt("zeta-inspired-next-edit")).toContain("not answering");
    expect(buildSystemPrompt("zeta-inspired-next-edit")).toContain("complete question");
  });

  test("builds bounded summary context", () => {
    const context = buildFimContext(
      {
        text: "alpha beta",
        cursorOffset: "alpha".length,
        cwd: "/repo",
        assistantSummary: "1234567890",
        signal: new AbortController().signal,
      },
      { maxPrefixChars: 10, maxSuffixChars: 10, maxAssistantSummaryChars: 4 },
    );

    expect(context.assistantSummary).toBe("7890");
  });

  test("normalizes model wrappers and avoids suffix duplication", () => {
    expect(normalizeCompletion("```text\nthere\n```", " friend")).toBe("there");
    expect(normalizeCompletion(" friend", " friend forever")).toBe("");
    expect(normalizeCompletion(" world!", " world")).toBe("!");
  });

  test("invalid explicit models do not fall back to implicit cloud models", async () => {
    const backend = createPiAiAutocompleteBackend(
      {
        model: undefined,
        modelRegistry: {
          find: () => {
            throw new Error("model lookup should not run for invalid refs");
          },
        },
        ui: { setStatus: () => undefined, theme: { fg: (_key: string, value: string) => value } },
      } as never,
      { ...defaultAiAutocompleteSettings, models: ["local-cpu"] },
    );

    await expect(
      backend.complete({
        text: "complete this prompt",
        cursorOffset: "complete this prompt".length,
        cwd: "/repo",
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ text: "" });
  });

  test("debounced runner drops stale debounce", () => {
    vi.useFakeTimers();
    const runner = new DebouncedAiAutocompleteRunner(50);
    const signals: AbortSignal[] = [];
    const results: string[] = [];

    runner.schedule(
      (signal) => {
        signals.push(signal);
        return Promise.resolve("first");
      },
      (result) => results.push(result),
    );
    runner.schedule(
      (signal) => {
        signals.push(signal);
        return Promise.resolve("second");
      },
      (result) => results.push(result),
    );

    vi.advanceTimersByTime(50);

    expect(signals).toHaveLength(1);
    expect(results).toEqual([]);
    vi.useRealTimers();
  });

  test("debounced runner aborts in-flight request", () => {
    vi.useFakeTimers();
    const runner = new DebouncedAiAutocompleteRunner(10);
    const signals: AbortSignal[] = [];

    runner.schedule(
      (signal) => {
        signals.push(signal);
        return new Promise<string>(() => undefined);
      },
      () => undefined,
    );
    vi.advanceTimersByTime(10);

    runner.schedule(
      (signal) => {
        signals.push(signal);
        return Promise.resolve("second");
      },
      () => undefined,
    );

    expect(signals[0]?.aborted).toBe(true);
    vi.useRealTimers();
  });

  test("debounced runner catches backend rejection", async () => {
    vi.useFakeTimers();
    const runner = new DebouncedAiAutocompleteRunner(10);

    expect(() => {
      runner.schedule(
        () => Promise.reject(new Error("boom")),
        () => undefined,
      );
      vi.advanceTimersByTime(10);
    }).not.toThrow();

    await Promise.resolve();
    vi.useRealTimers();
  });

  test("core editor renders and accepts backend completion", async () => {
    initTheme("dark");
    vi.useFakeTimers();
    const editor = createCorePromptEditorFactory(
      () => activeTheme,
      () => true,
      {
        backend: {
          id: "test",
          complete: () => Promise.resolve({ text: " please" }),
        },
        settings: { ...defaultAiAutocompleteSettings, enabled: true, mode: "eager", debounceMs: 0 },
        cwd: "/repo",
      },
    )(
      { requestRender: () => undefined, terminal: { rows: 24 } } as never,
      getEditorTheme(),
      KeybindingsManager.create(),
    );

    editor.setText("help me");
    vi.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();

    const rendered = editor.render(80).join("\n");
    expect(rendered).toContain("please");
    expect(rendered).not.toContain("↳");
    editor.handleInput("\t");
    expect(editor.getText()).toBe("help me please");
    editor.dispose();
    vi.useRealTimers();
  });

  test("core editor does not accept hidden middle-cursor completion", async () => {
    initTheme("dark");
    vi.useFakeTimers();
    const editor = createCorePromptEditorFactory(
      () => activeTheme,
      () => true,
      {
        backend: {
          id: "test",
          complete: () => Promise.resolve({ text: " hidden" }),
        },
        settings: { ...defaultAiAutocompleteSettings, enabled: true, mode: "eager", debounceMs: 0 },
        cwd: "/repo",
      },
    )(
      { requestRender: () => undefined, terminal: { rows: 24 } } as never,
      getEditorTheme(),
      KeybindingsManager.create(),
    );

    editor.setText("before after");
    for (let index = 0; index < "after".length; index += 1) {
      editor.handleInput("\u001B[D");
    }
    editor.handleInput("_");
    vi.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();

    editor.handleInput("\t");
    expect(editor.getText()).toBe("before _after");
    editor.dispose();
    vi.useRealTimers();
  });

  test("lazy mode waits for configured trigger shortcut", async () => {
    initTheme("dark");
    vi.useFakeTimers();
    let calls = 0;
    let triggerAutocomplete: (() => void) | undefined;
    const editor = createCorePromptEditorFactory(
      () => activeTheme,
      () => true,
      {
        backend: {
          id: "test",
          complete: () => {
            calls += 1;
            return Promise.resolve({ text: " now" });
          },
        },
        settings: {
          ...defaultAiAutocompleteSettings,
          enabled: true,
          mode: "lazy",
          debounceMs: 0,
        },
        cwd: "/repo",
        setTriggerAutocomplete: (trigger) => {
          triggerAutocomplete = trigger;
        },
      },
    )(
      { requestRender: () => undefined, terminal: { rows: 24 } } as never,
      getEditorTheme(),
      KeybindingsManager.create(),
    );

    editor.setText("help me");
    vi.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(0);

    triggerAutocomplete?.();
    vi.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1);
    editor.handleInput("\t");
    expect(editor.getText()).toBe("help me now");

    editor.dispose();
    vi.useRealTimers();
  });

  test("cancel callback aborts pending eager completion", () => {
    initTheme("dark");
    vi.useFakeTimers();
    let calls = 0;
    let cancelAutocomplete: (() => void) | undefined;
    const editor = createCorePromptEditorFactory(
      () => activeTheme,
      () => true,
      {
        backend: {
          id: "test",
          complete: () => {
            calls += 1;
            return Promise.resolve({ text: " no" });
          },
        },
        settings: {
          ...defaultAiAutocompleteSettings,
          enabled: true,
          mode: "eager",
          debounceMs: 10,
        },
        cwd: "/repo",
        setCancelAutocomplete: (cancel) => {
          cancelAutocomplete = cancel;
        },
      },
    )(
      { requestRender: () => undefined, terminal: { rows: 24 } } as never,
      getEditorTheme(),
      KeybindingsManager.create(),
    );

    editor.setText("help me now");
    cancelAutocomplete?.();
    vi.advanceTimersByTime(10);
    expect(calls).toBe(0);
    editor.dispose();
    vi.useRealTimers();
  });
});
