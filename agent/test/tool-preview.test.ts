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
  getToolPreviewPanels,
  getToolPreviewScenarios,
  renderPreviewText,
  renderPreviewLines,
} from "./tool-preview-scenarios.js";

initTheme("dark");
setKeybindings(KeybindingsManager.create());

test("apply_patch preview renders collapsed and expanded states", () => {
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
  assert.match(stripAnsi(errorText), /✗ patch 4 files/);
  assert.match(stripAnsi(errorText), /src\/tool-preview-modern.ts/);
  assert.match(stripAnsi(expandedText), /M src\/extensions\/patch.ts/);
  assert.match(stripAnsi(expandedText), /A src\/tool-preview-demo.ts/);
  assert.match(stripAnsi(expandedText), /diff --git a\/src\/extensions\/patch.ts b\/src\/extensions\/patch.ts/);
  assert.doesNotMatch(stripAnsi(expandedText), /\*\*\* Update File:/);
});

test("single-file patch collapsed success avoids duplicate summary line", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "apply_patch:single-file");
  assert.ok(scenario);

  const collapsed = getToolPreviewPanels(scenario).find((panel) => panel.id === "success-collapsed");
  assert.ok(collapsed);

  const text = stripAnsi(renderPreviewText(scenario, collapsed, 120));
  assert.match(text, /✓ patched src\/extensions\/patch.ts/);
  assert.doesNotMatch(text, /↳/);
});

test("streaming apply_patch call shows incoming patch lines", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "apply_patch:streaming-call");
  assert.ok(scenario);

  const collapsed = getToolPreviewPanels(scenario).find((panel) => panel.id === "call-collapsed");
  assert.ok(collapsed);

  const text = stripAnsi(renderPreviewText(scenario, collapsed, 120));
  assert.match(text, /patching 2 files/);
  assert.match(text, /\*\*\* Update File: src\/extensions\/patch.ts/);
  assert.match(text, /\+export const preview = true;/);
});

test("rehydrated apply_patch result stays collapsed", () => {
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

  assert.match(text, /✓ patched src\/extensions\/patch\.ts/);
  assert.doesNotMatch(text, /\bpatching\b/);
  assert.doesNotMatch(text, /\*\*\* Update File:/);
});

test("all preview scenarios render within width 120", () => {
  for (const scenario of getToolPreviewScenarios()) {
    for (const panel of getToolPreviewPanels(scenario)) {
      const lines = renderPreviewLines(scenario, panel, 120);
      assertVisibleWidths(lines, 120);
    }
  }
});

test("compact bash preview renders condensed collapsed result", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "bash:compact");
  assert.ok(scenario);

  const collapsed = getToolPreviewPanels(scenario).find((panel) => panel.id === "success-collapsed");
  const error = getToolPreviewPanels(scenario).find((panel) => panel.id === "error-collapsed");
  const expanded = getToolPreviewPanels(scenario).find((panel) => panel.id === "success-expanded");

  assert.ok(collapsed);
  assert.ok(error);
  assert.ok(expanded);

  const collapsedText = renderPreviewText(scenario, collapsed, 120);
  const errorText = renderPreviewText(scenario, error, 120);
  const expandedText = renderPreviewText(scenario, expanded, 120);

  assert.match(stripAnsi(collapsedText), /^\s*(?:▏\s*)?\$ npm run test:tool-preview/m);
  assert.match(stripAnsi(collapsedText), /2 lines · exit ok/);
  assert.match(stripAnsi(errorText), /stderr: preview command failed/);
  assert.match(stripAnsi(errorText), /exit 1|exit code: 1/);
  assert.match(stripAnsi(errorText), /ctrl\+o to expand/);
  assert.doesNotMatch(stripAnsi(collapsedText), /apply_patch preview renders collapsed/);
  assert.match(stripAnsi(expandedText), /apply_patch preview renders collapsed and expanded states/);
});

test("multiline bash call preview truncates middle lines in collapsed mode", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "bash:multiline-call");
  assert.ok(scenario);

  const collapsed = getToolPreviewPanels(scenario).find((panel) => panel.id === "call-collapsed");
  const expanded = getToolPreviewPanels(scenario).find((panel) => panel.id === "call-expanded");

  assert.ok(collapsed);
  assert.ok(expanded);

  const collapsedText = stripAnsi(renderPreviewText(scenario, collapsed, 120));
  const expandedText = stripAnsi(renderPreviewText(scenario, expanded, 120));

  assert.match(collapsedText, /^\s*(?:▏\s*)?\$ node --import tsx - <<'EOF'/m);
  assert.match(collapsedText, /import \{ readFile \} from 'node:fs\/promises';/);
  assert.match(collapsedText, /\.\.\. \(3 more lines, ctrl\+o to expand\)/);
  assert.match(collapsedText, /console\.log\(await readFile\('package\.json', 'utf8'\)\);/);
  assert.match(collapsedText, /EOF/);
  assert.match(expandedText, /const files = \['src\/a.ts', 'src\/b.ts', 'src\/c.ts'\];/);
});

test("failed multiline bash preview keeps a single expand hint and truncates long lines", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "bash:multiline-call");
  assert.ok(scenario);

  const error = getToolPreviewPanels(scenario).find((panel) => panel.id === "error-collapsed");
  assert.ok(error);

  const text = stripAnsi(renderPreviewText(scenario, error, 120));
  const expandHintCount = text.match(/ctrl\+o to expand/g)?.length ?? 0;

  assert.match(text, /truncated \d+ chars/);
  assert.equal(expandHintCount, 1);
});

test("tool previews render a bare left rail instead of a box wrapper", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "bash:compact");
  assert.ok(scenario);

  const collapsed = getToolPreviewPanels(scenario).find((panel) => panel.id === "success-collapsed");
  assert.ok(collapsed);

  const text = stripAnsi(renderPreviewText(scenario, collapsed, 120));

  assert.match(text, /^\s*▏\s*\$/m);
});

test("interactive mode only spaces tool calls when a visible non-tool item interrupts them", () => {
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

test("compact tool previews use verb-first muted statuses", () => {
  const expectations = [
    ["read:compact", "call-collapsed", /reading/],
    ["read:compact", "success-collapsed", /✓ read/],
    ["edit:compact", "success-collapsed", /✓ edited/],
    ["write:compact", "success-collapsed", /✓ written/],
  ] as const;

  for (const [scenarioId, panelId, pattern] of expectations) {
    const scenario = getToolPreviewScenarios().find((item) => item.id === scenarioId);
    assert.ok(scenario);
    const panel = getToolPreviewPanels(scenario).find((item) => item.id === panelId);
    assert.ok(panel);
    assert.match(stripAnsi(renderPreviewText(scenario, panel, 120)), pattern);
  }
});

test("grouped read batch preview renders collapsed and expanded summaries", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "read:batch");
  assert.ok(scenario);

  const collapsed = getToolPreviewPanels(scenario).find((panel) => panel.id === "success-collapsed");
  const expanded = getToolPreviewPanels(scenario).find((panel) => panel.id === "success-expanded");

  assert.ok(collapsed);
  assert.ok(expanded);

  const collapsedText = renderPreviewText(scenario, collapsed, 120);
  const expandedText = renderPreviewText(scenario, expanded, 120);

  assert.match(stripAnsi(collapsedText), /✓ batched 3 reads/);
  assert.match(stripAnsi(collapsedText), /README\.md/);
  assert.match(stripAnsi(expandedText), /✓ read \.\/README\.md/);
  assert.match(stripAnsi(expandedText), /✓ read \.\/src\/extensions\/patch\.ts/);
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
