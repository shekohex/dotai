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
  formatPreviousSuggestions,
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
    expect(defaultAiAutocompleteSettings.temperature).toBe(0);
  });

  test("previous suggestions are trimmed before prompt injection", () => {
    const suggestions = [" alpha ", "beta\ngamma", "<tag>", "x".repeat(300)];

    const formatted = formatPreviousSuggestions(suggestions);

    expect(formatted.length).toBeLessThanOrEqual(250);
    expect(formatted).toContain("<suggestion>alpha</suggestion>");
    expect(formatted).toContain("<suggestion>beta\\ngamma</suggestion>");
    expect(formatted).toContain("<suggestion>&lt;tag&gt;</suggestion>");
    expect(formatted).not.toContain("\nbeta\ngamma");
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

    expect(context).toEqual({
      prefix: "beta",
      suffix: " gamma",
      cwd: "/repo",
      trigger: "eager",
      generationAttempt: 1,
    });
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

  test("builds prompt with previous suggestions to avoid", () => {
    const context = buildFimContext(
      {
        text: "help me",
        cursorOffset: "help me".length,
        cwd: "/repo",
        previousSuggestions: [" please"],
        signal: new AbortController().signal,
      },
      defaultAiAutocompleteSettings,
    );

    expect(buildZetaNextEditPrompt(context)).toContain("Previous suggestions");
    expect(buildZetaNextEditPrompt(context)).toContain("<suggestion>please</suggestion>");
  });

  test("builds manual retry context for repeated trigger", () => {
    const context = buildFimContext(
      {
        text: "help me",
        cursorOffset: "help me".length,
        cwd: "/repo",
        trigger: "manual",
        generationAttempt: 2,
        signal: new AbortController().signal,
      },
      defaultAiAutocompleteSettings,
    );

    const prompt = buildZetaNextEditPrompt(context);
    expect(prompt).toContain("<trigger>manual</trigger>");
    expect(prompt).toContain("<generation_attempt>2</generation_attempt>");
    expect(prompt).toContain("fresh alternative");
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
    ).resolves.toEqual({ suggestions: [] });
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
          complete: () => Promise.resolve({ suggestions: [" please"] }),
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

  test("core editor keeps multiline completion ghost on one rendered line", async () => {
    initTheme("dark");
    vi.useFakeTimers();
    const editor = createCorePromptEditorFactory(
      () => activeTheme,
      () => true,
      {
        backend: {
          id: "test",
          complete: () => Promise.resolve({ suggestions: [" interface Foo {\n  bar: string;\n}"] }),
        },
        settings: { ...defaultAiAutocompleteSettings, enabled: true, mode: "eager", debounceMs: 0 },
        cwd: "/repo",
      },
    )(
      { requestRender: () => undefined, terminal: { rows: 24 } } as never,
      getEditorTheme(),
      KeybindingsManager.create(),
    );

    editor.setText("type");
    vi.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();

    const renderedLines = editor.render(80);
    expect(renderedLines.every((line) => !line.includes("\n"))).toBe(true);
    expect(renderedLines.join("\n")).toContain("interface Foo {…");
    expect(renderedLines.join("\n")).not.toContain("bar: string");
    editor.handleInput("\t");
    expect(editor.getText()).toBe("type interface Foo {\n  bar: string;\n}");
    editor.dispose();
    vi.useRealTimers();
  });

  test("core editor previews carriage-return completion on one rendered line", async () => {
    initTheme("dark");
    vi.useFakeTimers();
    const editor = createCorePromptEditorFactory(
      () => activeTheme,
      () => true,
      {
        backend: {
          id: "test",
          complete: () => Promise.resolve({ suggestions: [" foo\rbar"] }),
        },
        settings: { ...defaultAiAutocompleteSettings, enabled: true, mode: "eager", debounceMs: 0 },
        cwd: "/repo",
      },
    )(
      { requestRender: () => undefined, terminal: { rows: 24 } } as never,
      getEditorTheme(),
      KeybindingsManager.create(),
    );

    editor.setText("type");
    vi.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();

    const rendered = editor.render(80).join("\n");
    expect(rendered).toContain("foo…");
    expect(rendered).not.toContain("bar");
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
          complete: () => Promise.resolve({ suggestions: [" hidden"] }),
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
            return Promise.resolve({ suggestions: [" now"] });
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

  test("lazy autocomplete stores repeated suggestions and cycles them", async () => {
    initTheme("dark");
    vi.useFakeTimers();
    const backendSuggestions = [" first", " second"];
    const previousSuggestionsCalls: Array<string[] | undefined> = [];
    const generationAttemptCalls: Array<number | undefined> = [];
    let triggerAutocomplete: (() => void) | undefined;
    let cycleAutocompleteSuggestion: ((direction: 1 | -1) => void) | undefined;
    const editor = createCorePromptEditorFactory(
      () => activeTheme,
      () => true,
      {
        backend: {
          id: "test",
          complete: (input) => {
            previousSuggestionsCalls.push(input.previousSuggestions);
            generationAttemptCalls.push(input.generationAttempt);
            return Promise.resolve({ suggestions: [backendSuggestions.shift() ?? " second"] });
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
        setCycleAutocompleteSuggestion: (cycle) => {
          cycleAutocompleteSuggestion = cycle;
        },
      },
    )(
      { requestRender: () => undefined, terminal: { rows: 24 } } as never,
      getEditorTheme(),
      KeybindingsManager.create(),
    );

    editor.setText("pick");
    triggerAutocomplete?.();
    vi.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(editor.render(80).join("\n")).toContain("first");

    triggerAutocomplete?.();
    vi.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(editor.render(80).join("\n")).toContain("second");
    expect(previousSuggestionsCalls).toEqual([undefined, [" first"]]);

    cycleAutocompleteSuggestion?.(-1);
    expect(editor.render(80).join("\n")).toContain("first");
    cycleAutocompleteSuggestion?.(1);
    expect(editor.render(80).join("\n")).toContain("second");

    editor.handleInput("\u001B[44;6u");
    expect(editor.render(80).join("\n")).toContain("first");
    editor.handleInput("\u001B[44;5u");
    expect(editor.render(80).join("\n")).toContain("second");

    editor.handleInput("!");
    cycleAutocompleteSuggestion?.(-1);
    editor.handleInput("\t");
    expect(editor.getText()).toBe("pick!");

    editor.dispose();
    vi.useRealTimers();
  });

  test("ctrl-period trigger path preserves previous suggestions", async () => {
    initTheme("dark");
    vi.useFakeTimers();
    const backendSuggestions = [" first", " second"];
    const previousSuggestionsCalls: Array<string[] | undefined> = [];
    const generationAttemptCalls: Array<number | undefined> = [];
    const editor = createCorePromptEditorFactory(
      () => activeTheme,
      () => true,
      {
        backend: {
          id: "test",
          complete: (input) => {
            previousSuggestionsCalls.push(input.previousSuggestions);
            generationAttemptCalls.push(input.generationAttempt);
            return Promise.resolve({ suggestions: [backendSuggestions.shift() ?? " second"] });
          },
        },
        settings: { ...defaultAiAutocompleteSettings, enabled: true, mode: "lazy", debounceMs: 0 },
        cwd: "/repo",
      },
    )(
      { requestRender: () => undefined, terminal: { rows: 24 } } as never,
      getEditorTheme(),
      KeybindingsManager.create(),
    );

    editor.setText("pick");
    editor.handleInput("\u001B[46;5u");
    vi.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();
    editor.handleInput("\u001B[46;5u");
    vi.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(previousSuggestionsCalls).toEqual([undefined, [" first"]]);
    expect(generationAttemptCalls).toEqual([1, 2]);
    editor.dispose();
    vi.useRealTimers();
  });

  test("repeated ctrl-period aborts in-flight request and starts fresh attempt", () => {
    initTheme("dark");
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const generationAttemptCalls: Array<number | undefined> = [];
    const editor = createCorePromptEditorFactory(
      () => activeTheme,
      () => true,
      {
        backend: {
          id: "test",
          complete: (input) => {
            signals.push(input.signal);
            generationAttemptCalls.push(input.generationAttempt);
            return new Promise(() => undefined);
          },
        },
        settings: { ...defaultAiAutocompleteSettings, enabled: true, mode: "lazy", debounceMs: 0 },
        cwd: "/repo",
      },
    )(
      { requestRender: () => undefined, terminal: { rows: 24 } } as never,
      getEditorTheme(),
      KeybindingsManager.create(),
    );

    editor.setText("pick");
    editor.handleInput("\u001B[46;5u");
    vi.advanceTimersByTime(0);
    editor.handleInput("\u001B[46;5u");
    vi.advanceTimersByTime(0);

    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(generationAttemptCalls).toEqual([1, 2]);
    editor.dispose();
    vi.useRealTimers();
  });

  test("cursor movement invalidates autocomplete suggestions", async () => {
    initTheme("dark");
    vi.useFakeTimers();
    const editor = createCorePromptEditorFactory(
      () => activeTheme,
      () => true,
      {
        backend: {
          id: "test",
          complete: () => Promise.resolve({ suggestions: [" stale"] }),
        },
        settings: { ...defaultAiAutocompleteSettings, enabled: true, mode: "eager", debounceMs: 0 },
        cwd: "/repo",
      },
    )(
      { requestRender: () => undefined, terminal: { rows: 24 } } as never,
      getEditorTheme(),
      KeybindingsManager.create(),
    );

    editor.setText("move");
    vi.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();

    editor.handleInput("\u001B[D");
    editor.handleInput("\u001B[C");
    editor.handleInput("\t");
    expect(editor.getText()).toBe("move");
    editor.dispose();
    vi.useRealTimers();
  });

  test("typing cancels running autocomplete immediately", () => {
    initTheme("dark");
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const editor = createCorePromptEditorFactory(
      () => activeTheme,
      () => true,
      {
        backend: {
          id: "test",
          complete: (input) => {
            requestSignal = input.signal;
            return new Promise(() => undefined);
          },
        },
        settings: { ...defaultAiAutocompleteSettings, enabled: true, mode: "eager", debounceMs: 0 },
        cwd: "/repo",
      },
    )(
      { requestRender: () => undefined, terminal: { rows: 24 } } as never,
      getEditorTheme(),
      KeybindingsManager.create(),
    );

    editor.setText("spin");
    vi.advanceTimersByTime(0);

    editor.handleInput("!");
    expect(requestSignal?.aborted).toBe(true);
    expect(editor.getText()).toBe("spin!");

    editor.dispose();
    vi.useRealTimers();
  });

  test("backspace delete escape and setText cancel running autocomplete", () => {
    initTheme("dark");
    vi.useFakeTimers();
    let escapeCount = 0;
    const signals: AbortSignal[] = [];
    const editor = createCorePromptEditorFactory(
      () => activeTheme,
      () => true,
      {
        backend: {
          id: "test",
          complete: (input) => {
            signals.push(input.signal);
            return new Promise(() => undefined);
          },
        },
        settings: { ...defaultAiAutocompleteSettings, enabled: true, mode: "eager", debounceMs: 0 },
        cwd: "/repo",
      },
    )(
      { requestRender: () => undefined, terminal: { rows: 24 } } as never,
      getEditorTheme(),
      KeybindingsManager.create(),
    );
    editor.onEscape = () => {
      escapeCount += 1;
    };

    editor.setText("abcd");
    vi.advanceTimersByTime(0);
    editor.handleInput("\u007F");
    expect(signals.at(-1)?.aborted).toBe(true);

    vi.advanceTimersByTime(0);
    editor.handleInput("\u001B[3~");
    expect(signals.at(-1)?.aborted).toBe(true);

    vi.advanceTimersByTime(0);
    editor.handleInput("\u001B");
    expect(signals.at(-1)?.aborted).toBe(true);
    expect(escapeCount).toBe(0);

    vi.advanceTimersByTime(0);
    editor.setText("changed");
    expect(signals.at(-1)?.aborted).toBe(true);

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
            return Promise.resolve({ suggestions: [" no"] });
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
