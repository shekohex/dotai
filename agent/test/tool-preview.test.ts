import test from "node:test";
import assert from "node:assert/strict";
import { initTheme, InteractiveMode } from "@mariozechner/pi-coding-agent";
import { setKeybindings } from "@mariozechner/pi-tui";
import { ToolExecutionComponent } from "@mariozechner/pi-coding-agent";
import { KeybindingsManager } from "../node_modules/@mariozechner/pi-coding-agent/dist/core/keybindings.js";
import stripAnsi from "strip-ansi";
import { createReadToolOverrideDefinition } from "../src/extensions/coreui/tools.js";
import {
  assertVisibleWidths,
  createPreviewComponent,
  getToolPreviewPanels,
  getToolPreviewScenarios,
  renderPreviewText,
  renderPreviewLines,
} from "./tool-preview-scenarios.js";

initTheme("dark");
setKeybindings(KeybindingsManager.create());

const TEST_TIMEOUT_MS = 15_000;

const timedTest: typeof test = ((name: string, fn: (...args: any[]) => any) => test(name, { timeout: TEST_TIMEOUT_MS }, fn)) as typeof test;

timedTest("apply_patch preview renders collapsed and expanded states", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "apply_patch:multi-file");
  assert.ok(scenario);

  const collapsed = getToolPreviewPanels(scenario).find((panel) => panel.id === "success-collapsed");
  const partial = getToolPreviewPanels(scenario).find((panel) => panel.id === "partial-collapsed");
  const error = getToolPreviewPanels(scenario).find((panel) => panel.id === "error-expanded");
  const expanded = getToolPreviewPanels(scenario).find((panel) => panel.id === "success-expanded");

  assert.ok(collapsed);
  assert.ok(partial);
  assert.ok(error);
  assert.ok(expanded);

  const collapsedText = renderPreviewText(scenario, collapsed, 120);
  const partialText = renderPreviewText(scenario, partial, 120);
  const errorText = renderPreviewText(scenario, error, 120);
  const expandedText = renderPreviewText(scenario, expanded, 120);

  assert.match(stripAnsi(partialText), /patching 4 files/);
  assert.match(stripAnsi(partialText), /0\/4/);
  assert.match(stripAnsi(partialText), /src\/extensions\/patch.ts/);
  assert.match(stripAnsi(collapsedText), /patched 4 files/);
  assert.match(stripAnsi(collapsedText), /\+\d+ -\d+/);
  assert.match(stripAnsi(collapsedText), /A src\/tool-preview-demo.ts/);
  assert.match(stripAnsi(collapsedText), /D src\/tool-preview-old.ts/);
  assert.match(stripAnsi(errorText), /patch 4 files/);
  assert.match(stripAnsi(errorText), /src\/tool-preview-modern.ts/);
  assert.match(stripAnsi(expandedText), /M src\/extensions\/patch.ts/);
  assert.match(stripAnsi(expandedText), /A src\/tool-preview-demo.ts/);
  assert.match(stripAnsi(expandedText), /diff --git a\/src\/extensions\/patch.ts b\/src\/extensions\/patch.ts/);
  assert.doesNotMatch(stripAnsi(expandedText), /\*\*\* Update File:/);
});

timedTest("single-file patch collapsed success avoids duplicate summary line", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "apply_patch:single-file");
  assert.ok(scenario);

  const collapsed = getToolPreviewPanels(scenario).find((panel) => panel.id === "success-collapsed");
  assert.ok(collapsed);

  const text = stripAnsi(renderPreviewText(scenario, collapsed, 120));
  assert.match(text, /patched src\/extensions\/patch.ts/);
  assert.doesNotMatch(text, /↳/);
});

timedTest("streaming apply_patch call shows incoming patch lines", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "apply_patch:streaming-call");
  assert.ok(scenario);

  const collapsed = getToolPreviewPanels(scenario).find((panel) => panel.id === "call-collapsed");
  assert.ok(collapsed);

  const text = stripAnsi(renderPreviewText(scenario, collapsed, 120));
  assert.match(text, /patching 2 files/);
  assert.match(text, /\*\*\* Update File: src\/extensions\/patch.ts/);
  assert.match(text, /\+export const preview = true;/);
});

timedTest("rehydrated apply_patch result stays collapsed", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "apply_patch:single-file");
  assert.ok(scenario);
  assert.ok(scenario.successResult);

  const component = new ToolExecutionComponent(
    scenario.toolName,
    "rehydrated-apply-patch",
    scenario.args,
    {},
    scenario.toolDefinition,
    { requestRender() {} } as never,
    scenario.cwd,
  );

  component.setExpanded(false);
  component.updateResult(
    {
      content: scenario.successResult.content,
      details: scenario.successResult.details,
      isError: false,
    },
    false,
  );

  const text = stripAnsi(component.render(120).join("\n"));

  assert.match(text, /patched src\/extensions\/patch\.ts/);
  assert.doesNotMatch(text, /\bpatching\b/);
  assert.doesNotMatch(text, /\*\*\* Update File:/);
});

timedTest("all preview scenarios render within width 120", () => {
  for (const scenario of getToolPreviewScenarios()) {
    for (const panel of getToolPreviewPanels(scenario)) {
      const lines = renderPreviewLines(scenario, panel, 120);
      assertVisibleWidths(lines, 120);
    }
  }
});

timedTest("compact bash preview renders condensed collapsed result", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "bash:compact");
  assert.ok(scenario);

  const collapsed = getToolPreviewPanels(scenario).find((panel) => panel.id === "success-collapsed");
  const error = getToolPreviewPanels(scenario).find((panel) => panel.id === "error-collapsed");
  const expanded = getToolPreviewPanels(scenario).find((panel) => panel.id === "success-expanded");

  assert.ok(collapsed);
  assert.ok(error);
  assert.ok(expanded);

  const collapsedText = renderPreviewText(scenario, collapsed, 120);
  const collapsedLines = renderPreviewLines(scenario, collapsed, 120).filter((line) => stripAnsi(line).trim().length > 0);
  const errorText = renderPreviewText(scenario, error, 120);
  const expandedText = renderPreviewText(scenario, expanded, 120);

  assert.equal(collapsedLines.length, 1);
  assert.match(stripAnsi(collapsedText), /Runs tool preview tests/);
  assert.match(stripAnsi(collapsedText), /Runs tool preview tests · ok took 2s \(2 lines\)/);
  assert.doesNotMatch(stripAnsi(collapsedText), /\n.*ok took 2s/);
  assert.match(stripAnsi(errorText), /exit 1/);
  assert.match(stripAnsi(errorText), /Runs tool preview tests · exit 1 took 2s \(4 lines\)/);
  assert.doesNotMatch(stripAnsi(collapsedText), /apply_patch preview renders collapsed/);
  assert.match(stripAnsi(expandedText), /npm run test:tool-preview/);
  assert.match(stripAnsi(expandedText), /apply_patch preview renders collapsed and expanded states/);
});

timedTest("webfetch preview renders pending, collapsed status, and expanded body", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "webfetch:compact");
  assert.ok(scenario);

  const pending = getToolPreviewPanels(scenario).find((panel) => panel.id === "partial-collapsed");
  const collapsed = getToolPreviewPanels(scenario).find((panel) => panel.id === "success-collapsed");
  const expanded = getToolPreviewPanels(scenario).find((panel) => panel.id === "success-expanded");
  const error = getToolPreviewPanels(scenario).find((panel) => panel.id === "error-collapsed");

  assert.ok(pending);
  assert.ok(collapsed);
  assert.ok(expanded);
  assert.ok(error);

  const pendingText = stripAnsi(renderPreviewText(scenario, pending, 120));
  const animatedPendingText = stripAnsi(createPreviewComponent(scenario, pending, undefined, 2000).render(120).join("\n"));
  const collapsedText = stripAnsi(renderPreviewText(scenario, collapsed, 120));
  const expandedText = stripAnsi(renderPreviewText(scenario, expanded, 120));
  const errorText = stripAnsi(renderPreviewText(scenario, error, 120));

  assert.match(pendingText, /fetching https:\/\/example\.com\/docs\/pi\/fetch-preview \(10s\)/);
  assert.match(pendingText, /Fetch preview/);
  assert.match(animatedPendingText, /Streaming body chunk/);
  assert.match(animatedPendingText, /line[s]? so far \(2s\)/);
  assert.match(collapsedText, /fetched https:\/\/example\.com\/docs\/pi\/fetch-preview in 4s/);
  assert.match(expandedText, /Fetch preview/);
  assert.match(expandedText, /=============|# Fetch preview/);
  assert.match(expandedText, /Full output saved to: \/tmp\/pi-fetch-preview\.txt|Full output saved to: \/tmp\/pi-webfetch-/);
  assert.match(errorText, /fetch https:\/\/example\.com\/docs\/pi\/fetch-preview/);
});

timedTest("websearch preview renders call, collapsed grounded summary, expanded sources, and error", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "websearch:grounded-answer");
  assert.ok(scenario);

  const call = getToolPreviewPanels(scenario).find((panel) => panel.id === "call-collapsed");
  const pending = getToolPreviewPanels(scenario).find((panel) => panel.id === "partial-collapsed");
  const pendingExpanded = getToolPreviewPanels(scenario).find((panel) => panel.id === "partial-expanded");
  const collapsed = getToolPreviewPanels(scenario).find((panel) => panel.id === "success-collapsed");
  const expanded = getToolPreviewPanels(scenario).find((panel) => panel.id === "success-expanded");
  const error = getToolPreviewPanels(scenario).find((panel) => panel.id === "error-collapsed");

  assert.ok(call);
  assert.ok(pending);
  assert.ok(pendingExpanded);
  assert.ok(collapsed);
  assert.ok(expanded);
  assert.ok(error);

  const callText = stripAnsi(renderPreviewText(scenario, call, 120));
  const pendingText = stripAnsi(renderPreviewText(scenario, pending, 120));
  const pendingExpandedText = stripAnsi(renderPreviewText(scenario, pendingExpanded, 120));
  const animatedPendingText = stripAnsi(createPreviewComponent(scenario, pending, undefined, 2000).render(120).join("\n"));
  const animatedPendingExpandedText = stripAnsi(createPreviewComponent(scenario, pendingExpanded, undefined, 2000).render(120).join("\n"));
  const collapsedText = stripAnsi(renderPreviewText(scenario, collapsed, 120));
  const expandedText = stripAnsi(renderPreviewText(scenario, expanded, 120));
  const errorText = stripAnsi(renderPreviewText(scenario, error, 120));

  assert.match(callText, /googling When did Next\.js 16 release and what changed\?/);
  assert.match(callText, /gemini-2\.5-flash/);
  assert.match(callText, /30s/);
  assert.match(pendingText, /googling When did Next\.js 16 release and what changed\?/);
  assert.match(pendingText, /Next\.js 16 released in October 2025/);
  assert.match(pendingText, /1 line so far \(0s\)/);
  assert.match(animatedPendingText, /\.{3} \(2 earlier lines\)/);
  assert.match(animatedPendingText, /7 lines so far \(2s\)/);
  assert.match(pendingExpandedText, /Next\.js 16 released in October 2025/);
  assert.match(animatedPendingExpandedText, /The upgrade guide also replaces ppr with cacheComponents/);
  assert.match(animatedPendingExpandedText, /Teams should re-run production build verification/);
  assert.match(animatedPendingExpandedText, /↳ 2s/);
  assert.match(collapsedText, /googled When did Next\.js 16 release and what changed\?/);
  assert.match(collapsedText, /answered · 3 grounded results · took 5s/);
  assert.doesNotMatch(collapsedText, /Next\.js 16 is the current major release/);
  assert.match(expandedText, /answered · 3 grounded results · took 5s/);
  assert.match(expandedText, /Sources/);
  assert.match(expandedText, /https:\/\/nextjs\.org\/blog\/next-16/);
  assert.match(expandedText, /Search queries/);
  assert.match(errorText, /googled When did Next\.js 16 release and what changed\?/);
});

timedTest("websearch minimal preview omits source and query counts", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "websearch:minimal-answer");
  assert.ok(scenario);

  const collapsed = getToolPreviewPanels(scenario).find((panel) => panel.id === "success-collapsed");
  assert.ok(collapsed);

  const text = stripAnsi(renderPreviewText(scenario, collapsed, 120));

  assert.match(text, /googled Has Bun 1\.3\.0 released yet\?/);
  assert.match(text, /gemini-2\.5-flash-lite/);
  assert.match(text, /answered · 0 grounded results · took 3s/);
});

timedTest("multiline bash call preview truncates middle lines in collapsed mode", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "bash:multiline-call");
  assert.ok(scenario);

  const collapsed = getToolPreviewPanels(scenario).find((panel) => panel.id === "call-collapsed");
  const expanded = getToolPreviewPanels(scenario).find((panel) => panel.id === "call-expanded");

  assert.ok(collapsed);
  assert.ok(expanded);

  const collapsedText = stripAnsi(renderPreviewText(scenario, collapsed, 120));
  const expandedText = stripAnsi(renderPreviewText(scenario, expanded, 120));

  assert.match(collapsedText, /Reads package.json using multiline script/);
  assert.match(expandedText, /node --import tsx - <<'EOF'/);
});

timedTest("failed multiline bash preview shows exit code on collapsed error", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "bash:multiline-call");
  assert.ok(scenario);

  const error = getToolPreviewPanels(scenario).find((panel) => panel.id === "error-collapsed");
  assert.ok(error);

  const text = stripAnsi(renderPreviewText(scenario, error, 120));

  assert.match(text, /exit 1/);
});

timedTest("tool previews render a bare left rail instead of a box wrapper", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "bash:compact");
  assert.ok(scenario);

  const collapsed = getToolPreviewPanels(scenario).find((panel) => panel.id === "success-collapsed");
  assert.ok(collapsed);

  const text = stripAnsi(renderPreviewText(scenario, collapsed, 120));

  assert.match(text, /^\s*▏\s*\$/m);
});

timedTest("interactive mode only spaces tool calls when a visible non-tool item interrupts them", () => {
  const cwd = process.cwd().replace(/\\/g, "/");
  const mode = createInteractiveModePreview(cwd);

  try {
    (mode as any).renderSessionContext({
      messages: [
        { role: "user", content: "Run the reads" },
        createAssistantToolCall("tool-1", `${cwd}/a.ts`),
        createAssistantToolCall("tool-2", `${cwd}/b.ts`),
        { role: "assistant", content: [{ type: "text", text: "Tool output interrupted." }] },
        createAssistantToolCall("tool-3", `${cwd}/c.ts`),
      ],
    });

    const lines = (mode as any).chatContainer.render(120).map((line: string) => stripAnsi(line).trimEnd());

    const firstToolIndex = lines.findIndex((line: string) => line.includes("a.ts"));
    const secondToolIndex = lines.findIndex((line: string) => line.includes("b.ts"));
    const interruptIndex = lines.findIndex((line: string) => line.includes("Tool output interrupted."));
    const thirdToolIndex = lines.findIndex((line: string) => line.includes("c.ts"));

    assert.notEqual(firstToolIndex, -1);
    assert.notEqual(secondToolIndex, -1);
    assert.notEqual(interruptIndex, -1);
    assert.notEqual(thirdToolIndex, -1);
    assert.equal(secondToolIndex - firstToolIndex, 1);
    assert.equal(thirdToolIndex - interruptIndex, 2);
  } finally {
    (mode as any).footerDataProvider.dispose();
  }
});

timedTest("compact tool previews use verb-first bold+dim statuses", () => {
  const expectations = [
    ["read:compact", "call-collapsed", /reading/],
    ["read:compact", "success-collapsed", /read/],
    ["edit:compact", "success-collapsed", /edited/],
    ["write:compact", "success-collapsed", /written/],
  ] as const;

  for (const [scenarioId, panelId, pattern] of expectations) {
    const scenario = getToolPreviewScenarios().find((item) => item.id === scenarioId);
    assert.ok(scenario);
    const panel = getToolPreviewPanels(scenario).find((item) => item.id === panelId);
    assert.ok(panel);
    assert.match(stripAnsi(renderPreviewText(scenario, panel, 120)), pattern);
  }
});

timedTest("grouped read batch preview renders collapsed and expanded summaries", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "read:batch");
  assert.ok(scenario);

  const collapsed = getToolPreviewPanels(scenario).find((panel) => panel.id === "success-collapsed");
  const expanded = getToolPreviewPanels(scenario).find((panel) => panel.id === "success-expanded");

  assert.ok(collapsed);
  assert.ok(expanded);

  const collapsedText = renderPreviewText(scenario, collapsed, 120);
  const expandedText = renderPreviewText(scenario, expanded, 120);

  assert.match(stripAnsi(collapsedText), /batched 3 reads/);
  assert.match(stripAnsi(collapsedText), /README\.md/);
  assert.match(stripAnsi(expandedText), /read \.\/README\.md/);
  assert.match(stripAnsi(expandedText), /read \.\/src\/extensions\/patch\.ts/);
});

timedTest("read SKILL.md renders as skill verb with skill name", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "read:skill-file");
  assert.ok(scenario);

  const call = getToolPreviewPanels(scenario).find((panel) => panel.id === "call-collapsed");
  const success = getToolPreviewPanels(scenario).find((panel) => panel.id === "success-collapsed");
  assert.ok(call);
  assert.ok(success);

  const callText = stripAnsi(renderPreviewText(scenario, call, 120));
  const successText = stripAnsi(renderPreviewText(scenario, success, 120));

  assert.match(callText, /reading.*git-commiting/);
  assert.match(successText, /skill git-commiting/);
  assert.doesNotMatch(callText, /SKILL\.md/);
  assert.doesNotMatch(successText, /SKILL\.md/);
});

function createInteractiveModePreview(cwd: string) {
  const readToolDefinition = createReadToolOverrideDefinition();
  const settingsManager = {
    getShowHardwareCursor: () => false,
    getClearOnShrink: () => false,
    getEditorPaddingX: () => 1,
    getAutocompleteMaxVisible: () => 8,
    getHideThinkingBlock: () => false,
    getTheme: () => "dark",
    getShowImages: () => false,
    getCodeBlockIndent: () => 2,
  };
  const sessionManager = {
    getCwd: () => cwd,
    getEntries: () => [],
    getSessionName: () => undefined,
  };
  const session = {
    autoCompactionEnabled: false,
    sessionManager,
    settingsManager,
    resourceLoader: {
      getThemes: () => ({ themes: [] }),
      getSkills: () => ({ skills: [] }),
    },
    getToolDefinition: (toolName: string) => (toolName === readToolDefinition.name ? readToolDefinition : undefined),
    state: { messages: [] },
  };

  return new InteractiveMode({ session, dispose: async () => {} } as never);
}

function createAssistantToolCall(id: string, filePath: string) {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id,
        name: "read",
        arguments: { path: filePath },
      },
    ],
  };
}
