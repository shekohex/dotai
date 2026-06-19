import { expect, test } from "vitest";
import { initTheme, InteractiveMode, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setKeybindings } from "@earendil-works/pi-tui";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import stripAnsi from "strip-ansi";
import {
  createBashToolOverrideDefinition,
  createReadToolOverrideDefinition,
} from "../src/extensions/coreui/tools.js";
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
const previewPi = { sendMessage() {} } as unknown as ExtensionAPI;

const timedTest: typeof test = ((name: string, fn: (...args: any[]) => any) =>
  test(name, { timeout: TEST_TIMEOUT_MS }, fn)) as typeof test;

timedTest("apply_patch preview renders collapsed and expanded states", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "apply_patch:multi-file");
  expect(scenario).toBeTruthy();

  const collapsed = getToolPreviewPanels(scenario).find(
    (panel) => panel.id === "success-collapsed",
  );
  const partial = getToolPreviewPanels(scenario).find((panel) => panel.id === "partial-collapsed");
  const error = getToolPreviewPanels(scenario).find((panel) => panel.id === "error-expanded");
  const expanded = getToolPreviewPanels(scenario).find((panel) => panel.id === "success-expanded");

  expect(collapsed).toBeTruthy();
  expect(partial).toBeTruthy();
  expect(error).toBeTruthy();
  expect(expanded).toBeTruthy();

  const collapsedText = renderPreviewText(scenario, collapsed, 120);
  const collapsedLines = renderPreviewLines(scenario, collapsed, 120).filter(
    (line) => stripAnsi(line).trim().length > 0,
  );
  const partialText = renderPreviewText(scenario, partial, 120);
  const errorText = renderPreviewText(scenario, error, 120);
  const expandedText = renderPreviewText(scenario, expanded, 120);

  expect(stripAnsi(partialText)).toMatch(/patching 4 files/);
  expect(stripAnsi(partialText)).toMatch(/0\/4/);
  expect(stripAnsi(partialText)).toMatch(/src\/extensions\/patch.ts/);
  expect(collapsedLines.length).toBe(1);
  expect(stripAnsi(collapsedText)).toMatch(/patched 4 files/);
  expect(stripAnsi(collapsedText)).toMatch(/\+\d+ -\d+/);
  expect(stripAnsi(collapsedText)).not.toMatch(/↳/);
  expect(stripAnsi(collapsedText)).not.toMatch(/A src\/tool-preview-demo.ts/);
  expect(stripAnsi(collapsedText)).not.toMatch(/D src\/tool-preview-old.ts/);
  expect(stripAnsi(errorText)).toMatch(/patch 4 files/);
  expect(stripAnsi(errorText)).toMatch(/src\/tool-preview-modern.ts/);
  expect(stripAnsi(expandedText)).toMatch(/M src\/extensions\/patch.ts/);
  expect(stripAnsi(expandedText)).toMatch(/A src\/tool-preview-demo.ts/);
  expect(stripAnsi(expandedText)).toMatch(
    /diff --git a\/src\/extensions\/patch.ts b\/src\/extensions\/patch.ts/,
  );
  expect(stripAnsi(expandedText)).not.toMatch(/\*\*\* Update File:/);
});

timedTest("single-file patch collapsed success avoids duplicate summary line", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "apply_patch:single-file");
  expect(scenario).toBeTruthy();

  const collapsed = getToolPreviewPanels(scenario).find(
    (panel) => panel.id === "success-collapsed",
  );
  expect(collapsed).toBeTruthy();

  const text = stripAnsi(renderPreviewText(scenario, collapsed, 120));
  expect(text).toMatch(/patched patch\.ts \.\/src\/extensions\/ · \+\d+ -\d+/);
  expect(text).not.toMatch(/↳/);
});

timedTest("streaming apply_patch call shows incoming patch lines", () => {
  const scenario = getToolPreviewScenarios().find(
    (item) => item.id === "apply_patch:streaming-call",
  );
  expect(scenario).toBeTruthy();

  const collapsed = getToolPreviewPanels(scenario).find((panel) => panel.id === "call-collapsed");
  expect(collapsed).toBeTruthy();

  const text = stripAnsi(renderPreviewText(scenario, collapsed, 120));
  expect(text).toMatch(/patching 2 files/);
  expect(text).toMatch(/\*\*\* Update File: src\/extensions\/patch.ts/);
  expect(text).toMatch(/\+export const preview = true;/);
});

timedTest("rehydrated apply_patch result stays collapsed", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "apply_patch:single-file");
  expect(scenario).toBeTruthy();
  expect(scenario.successResult).toBeTruthy();

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

  expect(text).toMatch(/patched patch\.ts \.\/src\/extensions\/ · \+\d+ -\d+/);
  expect(text).not.toMatch(/\bpatching\b/);
  expect(text).not.toMatch(/\*\*\* Update File:/);
});

timedTest("session_query preview appends collapsed result inline", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "session_query:compact");
  expect(scenario).toBeTruthy();

  const collapsed = getToolPreviewPanels(scenario).find(
    (panel) => panel.id === "success-collapsed",
  );
  const partial = getToolPreviewPanels(scenario).find((panel) => panel.id === "partial-collapsed");
  const expanded = getToolPreviewPanels(scenario).find((panel) => panel.id === "success-expanded");

  expect(collapsed).toBeTruthy();
  expect(partial).toBeTruthy();
  expect(expanded).toBeTruthy();

  const collapsedText = stripAnsi(renderPreviewText(scenario, collapsed, 120));
  const collapsedLines = renderPreviewLines(scenario, collapsed, 120).filter(
    (line) => stripAnsi(line).trim().length > 0,
  );
  const partialText = stripAnsi(renderPreviewText(scenario, partial, 120));
  const expandedText = stripAnsi(renderPreviewText(scenario, expanded, 120));

  expect(collapsedLines.length).toBe(1);
  expect(collapsedText).toMatch(
    /queried 0e990a27 → What files were modified in the parent session\?/,
  );
  expect(collapsedText).toMatch(/answered · took \d+s/);
  expect(collapsedText).not.toMatch(/↳/);
  expect(partialText).toMatch(/Modified files included src\/extensions\/coreui\/tools.ts/);
  expect(partialText).toMatch(/1 line so far \(0s\)/);
  expect(expandedText).toMatch(/Question:/);
  expect(expandedText).toMatch(/test\/tool-preview.test.ts/);
});

timedTest("subagent previews render representative action summaries and expanded metadata", () => {
  const startScenario = getToolPreviewScenarios().find((item) => item.id === "subagent:start");
  const messageScenario = getToolPreviewScenarios().find((item) => item.id === "subagent:message");
  const listScenario = getToolPreviewScenarios().find((item) => item.id === "subagent:list");
  const cancelScenario = getToolPreviewScenarios().find((item) => item.id === "subagent:cancel");

  expect(startScenario).toBeTruthy();
  expect(messageScenario).toBeTruthy();
  expect(listScenario).toBeTruthy();
  expect(cancelScenario).toBeTruthy();

  const startCollapsed = getToolPreviewPanels(startScenario).find(
    (panel) => panel.id === "success-collapsed",
  );
  const startExpanded = getToolPreviewPanels(startScenario).find(
    (panel) => panel.id === "success-expanded",
  );
  const startPartialCollapsed = getToolPreviewPanels(startScenario).find(
    (panel) => panel.id === "partial-collapsed",
  );
  const startPartialExpanded = getToolPreviewPanels(startScenario).find(
    (panel) => panel.id === "partial-expanded",
  );
  const messagePartialCollapsed = getToolPreviewPanels(messageScenario).find(
    (panel) => panel.id === "partial-collapsed",
  );
  const messagePartialExpanded = getToolPreviewPanels(messageScenario).find(
    (panel) => panel.id === "partial-expanded",
  );
  const messageCollapsed = getToolPreviewPanels(messageScenario).find(
    (panel) => panel.id === "success-collapsed",
  );
  const messageExpanded = getToolPreviewPanels(messageScenario).find(
    (panel) => panel.id === "success-expanded",
  );
  const listCollapsed = getToolPreviewPanels(listScenario).find(
    (panel) => panel.id === "success-collapsed",
  );
  const listExpanded = getToolPreviewPanels(listScenario).find(
    (panel) => panel.id === "success-expanded",
  );
  const cancelCollapsed = getToolPreviewPanels(cancelScenario).find(
    (panel) => panel.id === "success-collapsed",
  );
  const cancelExpanded = getToolPreviewPanels(cancelScenario).find(
    (panel) => panel.id === "success-expanded",
  );

  expect(startCollapsed).toBeTruthy();
  expect(startExpanded).toBeTruthy();
  expect(startPartialCollapsed).toBeTruthy();
  expect(startPartialExpanded).toBeTruthy();
  expect(messagePartialCollapsed).toBeTruthy();
  expect(messagePartialExpanded).toBeTruthy();
  expect(messageCollapsed).toBeTruthy();
  expect(messageExpanded).toBeTruthy();
  expect(listCollapsed).toBeTruthy();
  expect(listExpanded).toBeTruthy();
  expect(cancelCollapsed).toBeTruthy();
  expect(cancelExpanded).toBeTruthy();

  const startCollapsedText = stripAnsi(renderPreviewText(startScenario, startCollapsed, 120));
  const startExpandedText = stripAnsi(renderPreviewText(startScenario, startExpanded, 120));
  const startPartialCollapsedText = stripAnsi(
    renderPreviewText(startScenario, startPartialCollapsed, 120),
  );
  const startPartialExpandedText = stripAnsi(
    renderPreviewText(startScenario, startPartialExpanded, 120),
  );
  const animatedStartPartialCollapsedText = stripAnsi(
    createPreviewComponent(startScenario, startPartialCollapsed, undefined, 2000)
      .render(120)
      .join("\n"),
  );
  const animatedStartPartialExpandedText = stripAnsi(
    createPreviewComponent(startScenario, startPartialExpanded, undefined, 2000)
      .render(120)
      .join("\n"),
  );
  const messagePartialCollapsedText = stripAnsi(
    renderPreviewText(messageScenario, messagePartialCollapsed, 120),
  );
  const messagePartialExpandedText = stripAnsi(
    renderPreviewText(messageScenario, messagePartialExpanded, 120),
  );
  const animatedMessagePartialCollapsedText = stripAnsi(
    createPreviewComponent(messageScenario, messagePartialCollapsed, undefined, 1000)
      .render(120)
      .join("\n"),
  );
  const animatedMessagePartialExpandedText = stripAnsi(
    createPreviewComponent(messageScenario, messagePartialExpanded, undefined, 1000)
      .render(120)
      .join("\n"),
  );
  const messageCollapsedText = stripAnsi(renderPreviewText(messageScenario, messageCollapsed, 120));
  const messageExpandedText = stripAnsi(renderPreviewText(messageScenario, messageExpanded, 120));
  const listCollapsedText = stripAnsi(renderPreviewText(listScenario, listCollapsed, 120));
  const listExpandedText = stripAnsi(renderPreviewText(listScenario, listExpanded, 120));
  const cancelCollapsedText = stripAnsi(renderPreviewText(cancelScenario, cancelCollapsed, 120));
  const cancelExpandedText = stripAnsi(renderPreviewText(cancelScenario, cancelExpanded, 120));

  expect(startCollapsedText).toMatch(
    /π start · reviewer-two · review · Review preview renderer and note UI gaps · reviewer-two · running/,
  );
  expect(startPartialCollapsedText).toMatch(/π start .* · handoff/s);
  expect(startPartialExpandedText).toMatch(/Preparing handoff for reviewer-two/);
  expect(startPartialExpandedText).toMatch(/0s/);
  expect(animatedStartPartialCollapsedText).toMatch(/\.\.\. \(2 earlier lines\)/);
  expect(animatedStartPartialCollapsedText).toMatch(/7 lines so far \(2s\) · handoff/);
  expect(animatedStartPartialCollapsedText).toMatch(/SUBAGENT-TAIL-MARKER/);
  expect(animatedStartPartialCollapsedText).toMatch(/visible\./);
  expect(animatedStartPartialCollapsedText).not.toMatch(
    /We implemented tmux-backed subagents with session-backed persistence\./,
  );
  expect(animatedStartPartialExpandedText).toMatch(/## Context/);
  expect(animatedStartPartialExpandedText).toMatch(
    /We implemented tmux-backed subagents with session-backed persistence\./,
  );
  expect(animatedStartPartialExpandedText).toMatch(/handoff · 2s/);
  expect(animatedStartPartialExpandedText).toMatch(/keep SUBAGENT-TAIL-MARKER/);
  expect(animatedStartPartialExpandedText).toMatch(/visible\./);
  expect(startExpandedText).toMatch(/name: reviewer-two/);
  expect(startExpandedText).toMatch(/handoff: true/);
  expect(startExpandedText).toMatch(/prompt:/);
  expect(startExpandedText).toMatch(/promptGuidance:/);
  expect(startExpandedText).toMatch(
    /The subagent will return with a summary automatically when it.*finishes/is,
  );
  expect(startExpandedText).toMatch(/sessionPath: .*2d2c7b0c\.jsonl/);

  expect(messagePartialCollapsedText).toMatch(/1 line so far \(0s\) · message followUp/);
  expect(messagePartialExpandedText).toMatch(/Ping/);
  expect(animatedMessagePartialCollapsedText).toMatch(/2 lines so far \(1s\) · message followUp/);
  expect(animatedMessagePartialExpandedText).toMatch(/Ping/);
  expect(animatedMessagePartialExpandedText).toMatch(/Spacing\?/);
  expect(animatedMessagePartialExpandedText).toMatch(/message followUp · 1s/);
  const messageCollapsedLines = renderPreviewLines(messageScenario, messageCollapsed, 120).filter(
    (line) => stripAnsi(line).trim().length > 0,
  );
  expect(messageCollapsedLines.length).toBe(1);
  expect(messageCollapsedText).toMatch(/π message · 92ad1c07 · followUp · Ping Spacing\?/);
  expect(messageCollapsedText).toMatch(/doc-writer · running · followUp · Ping Spacing\?/);
  expect(messageExpandedText).toMatch(/delivery: followUp/);
  expect(messageExpandedText).toMatch(/message:/);
  expect(messageExpandedText).toMatch(/Ping/);
  expect(messageExpandedText).toMatch(/Spacing\?/);

  expect(listCollapsedText).toMatch(
    /π list · 5 agents · 1 running · 1 idle · 1 completed · 1 cancelled · 1 failed/,
  );
  expect(listExpandedText).toMatch(/count: 5/);
  expect(listExpandedText).toMatch(/subagent 1:/);
  expect(listExpandedText).toMatch(/name: worker-epsilon/);
  expect(listExpandedText).toMatch(/exitCode: 1/);

  expect(cancelCollapsedText).toMatch(/π cancel · c91e7f44 · stuck-worker · cancelled/);
  expect(cancelExpandedText).toMatch(/status: cancelled/);
  expect(cancelExpandedText).toMatch(/completedAt: 2026-04-11T18:16:00.000Z/);
});

timedTest("subagent preview error panels render action context and failure text", () => {
  const expectations = [
    [
      "subagent:start",
      /π start .* · error/s,
      /subagent start failed: tmux is not available in the current session/,
    ],
    [
      "subagent:message",
      /π message .* · error/s,
      /subagent message failed: sessionId 92ad1c07-f550-4f8a-9c84-8992c1d6a132 was not found in this parent session/is,
    ],
    ["subagent:list", /π list · error/, /failed to restore subagent state/],
    [
      "subagent:cancel",
      /π cancel .* · error/s,
      /subagent cancel failed: tmux kill-pane failed: no such pane: %15/,
    ],
  ] as const;

  for (const [scenarioId, headerPattern, bodyPattern] of expectations) {
    const scenario = getToolPreviewScenarios().find((item) => item.id === scenarioId);
    expect(scenario).toBeTruthy();
    const panel = getToolPreviewPanels(scenario).find((item) => item.id === "error-collapsed");
    expect(panel).toBeTruthy();
    const text = stripAnsi(renderPreviewText(scenario, panel, 120));
    expect(text).toMatch(headerPattern);
    expect(text).toMatch(bodyPattern);
  }
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
  expect(scenario).toBeTruthy();

  const collapsed = getToolPreviewPanels(scenario).find(
    (panel) => panel.id === "success-collapsed",
  );
  const error = getToolPreviewPanels(scenario).find((panel) => panel.id === "error-collapsed");
  const expanded = getToolPreviewPanels(scenario).find((panel) => panel.id === "success-expanded");

  expect(collapsed).toBeTruthy();
  expect(error).toBeTruthy();
  expect(expanded).toBeTruthy();

  const collapsedText = renderPreviewText(scenario, collapsed, 120);
  const collapsedLines = renderPreviewLines(scenario, collapsed, 120).filter(
    (line) => stripAnsi(line).trim().length > 0,
  );
  const errorText = renderPreviewText(scenario, error, 120);
  const expandedText = renderPreviewText(scenario, expanded, 120);

  expect(collapsedLines.length).toBe(1);
  expect(stripAnsi(collapsedText)).toMatch(/Runs tool preview tests/);
  expect(stripAnsi(collapsedText)).toMatch(/Runs tool preview tests · ok took 2s \(2 lines\)/);
  expect(stripAnsi(collapsedLines[0] ?? "")).toMatch(/ok took 2s/);
  expect(stripAnsi(errorText)).toMatch(/exit 1/);
  expect(stripAnsi(errorText)).toMatch(/Runs tool preview tests · exit 1 took 2s \(4 lines\)/);
  expect(stripAnsi(collapsedText)).not.toMatch(/apply_patch preview renders collapsed/);
  expect(stripAnsi(expandedText)).toMatch(/npm run test:tool-preview/);
  expect(stripAnsi(expandedText)).toMatch(
    /apply_patch preview renders collapsed and expanded states/,
  );
});

timedTest("webfetch preview renders pending, collapsed status, and expanded body", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "webfetch:compact");
  expect(scenario).toBeTruthy();

  const pending = getToolPreviewPanels(scenario).find((panel) => panel.id === "partial-collapsed");
  const collapsed = getToolPreviewPanels(scenario).find(
    (panel) => panel.id === "success-collapsed",
  );
  const expanded = getToolPreviewPanels(scenario).find((panel) => panel.id === "success-expanded");
  const error = getToolPreviewPanels(scenario).find((panel) => panel.id === "error-collapsed");

  expect(pending).toBeTruthy();
  expect(collapsed).toBeTruthy();
  expect(expanded).toBeTruthy();
  expect(error).toBeTruthy();

  const pendingText = stripAnsi(renderPreviewText(scenario, pending, 120));
  const animatedPendingText = stripAnsi(
    createPreviewComponent(scenario, pending, undefined, 2000).render(120).join("\n"),
  );
  const collapsedText = stripAnsi(renderPreviewText(scenario, collapsed, 120));
  const expandedText = stripAnsi(renderPreviewText(scenario, expanded, 120));
  const errorText = stripAnsi(renderPreviewText(scenario, error, 120));

  expect(pendingText).toMatch(/fetching https:\/\/example\.com\/docs\/pi\/fetch-preview \(10s\)/);
  expect(pendingText).toMatch(/Fetch preview/);
  expect(animatedPendingText).toMatch(/Streaming body chunk/);
  expect(animatedPendingText).toMatch(/line[s]? so far \(2s\)/);
  expect(collapsedText).toMatch(/fetched https:\/\/example\.com\/docs\/pi\/fetch-preview in 4s/);
  expect(expandedText).toMatch(/Fetch preview/);
  expect(expandedText).toMatch(/=============|# Fetch preview/);
  expect(expandedText).toMatch(
    /Full output saved to: \/tmp\/pi-fetch-preview\.txt|Full output saved to: \/tmp\/pi-webfetch-/,
  );
  expect(errorText).toMatch(/fetch https:\/\/example\.com\/docs\/pi\/fetch-preview/);
});

timedTest(
  "websearch preview renders call, collapsed grounded summary, expanded sources, and error",
  () => {
    const scenario = getToolPreviewScenarios().find(
      (item) => item.id === "websearch:grounded-answer",
    );
    expect(scenario).toBeTruthy();

    const call = getToolPreviewPanels(scenario).find((panel) => panel.id === "call-collapsed");
    const pending = getToolPreviewPanels(scenario).find(
      (panel) => panel.id === "partial-collapsed",
    );
    const pendingExpanded = getToolPreviewPanels(scenario).find(
      (panel) => panel.id === "partial-expanded",
    );
    const collapsed = getToolPreviewPanels(scenario).find(
      (panel) => panel.id === "success-collapsed",
    );
    const expanded = getToolPreviewPanels(scenario).find(
      (panel) => panel.id === "success-expanded",
    );
    const error = getToolPreviewPanels(scenario).find((panel) => panel.id === "error-collapsed");

    expect(call).toBeTruthy();
    expect(pending).toBeTruthy();
    expect(pendingExpanded).toBeTruthy();
    expect(collapsed).toBeTruthy();
    expect(expanded).toBeTruthy();
    expect(error).toBeTruthy();

    const callText = stripAnsi(renderPreviewText(scenario, call, 120));
    const pendingText = stripAnsi(renderPreviewText(scenario, pending, 120));
    const pendingExpandedText = stripAnsi(renderPreviewText(scenario, pendingExpanded, 120));
    const animatedPendingText = stripAnsi(
      createPreviewComponent(scenario, pending, undefined, 2000).render(120).join("\n"),
    );
    const animatedPendingExpandedText = stripAnsi(
      createPreviewComponent(scenario, pendingExpanded, undefined, 2000).render(120).join("\n"),
    );
    const collapsedText = stripAnsi(renderPreviewText(scenario, collapsed, 120));
    const expandedText = stripAnsi(renderPreviewText(scenario, expanded, 120));
    const errorText = stripAnsi(renderPreviewText(scenario, error, 120));

    expect(callText).toMatch(/googling When did Next\.js 16 release and what changed\?/);
    expect(callText).toMatch(/gemini-2\.5-flash/);
    expect(callText).toMatch(/30s/);
    expect(pendingText).toMatch(/googling When did Next\.js 16 release and what changed\?/);
    expect(pendingText).toMatch(/Next\.js 16 released in October 2025/);
    expect(pendingText).toMatch(/1 line so far \(0s\)/);
    expect(animatedPendingText).toMatch(/\.{3} \(2 earlier lines\)/);
    expect(animatedPendingText).toMatch(/7 lines so far \(2s\)/);
    expect(pendingExpandedText).toMatch(/Next\.js 16 released in October 2025/);
    expect(animatedPendingExpandedText).toMatch(
      /The upgrade guide also replaces ppr with cacheComponents/,
    );
    expect(animatedPendingExpandedText).toMatch(
      /Teams should re-run production build verification/,
    );
    expect(animatedPendingExpandedText).toMatch(/↳ 2s/);
    expect(collapsedText).toMatch(/googled When did Next\.js 16 release and what changed\?/);
    expect(collapsedText).toMatch(/answered · 3 grounded results · took 5s/);
    expect(collapsedText).not.toMatch(/Next\.js 16 is the current major release/);
    expect(expandedText).toMatch(/answered · 3 grounded results · took 5s/);
    expect(expandedText).toMatch(/Sources/);
    expect(expandedText).toMatch(/Next\.js 16/);
    expect(expandedText).toMatch(/Search queries/);
    expect(errorText).toMatch(/googled When did Next\.js 16 release and what changed\?/);
  },
);

timedTest("websearch minimal preview omits source and query counts", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "websearch:minimal-answer");
  expect(scenario).toBeTruthy();

  const collapsed = getToolPreviewPanels(scenario).find(
    (panel) => panel.id === "success-collapsed",
  );
  expect(collapsed).toBeTruthy();

  const text = stripAnsi(renderPreviewText(scenario, collapsed, 120));

  expect(text).toMatch(/googled Has Bun 1\.3\.0 released yet\?/);
  expect(text).toMatch(/gemini-2\.5-flash-lite/);
  expect(text).toMatch(/answered · 0 grounded results · took 3s/);
});

timedTest(
  "executor preview renders compact call, highlighted code, json result, and error states",
  () => {
    const scenario = getToolPreviewScenarios().find((item) => item.id === "executor:compact");
    expect(scenario).toBeTruthy();

    const call = getToolPreviewPanels(scenario).find((panel) => panel.id === "call-collapsed");
    const callExpanded = getToolPreviewPanels(scenario).find(
      (panel) => panel.id === "call-expanded",
    );
    const partial = getToolPreviewPanels(scenario).find(
      (panel) => panel.id === "partial-collapsed",
    );
    const partialExpanded = getToolPreviewPanels(scenario).find(
      (panel) => panel.id === "partial-expanded",
    );
    const success = getToolPreviewPanels(scenario).find(
      (panel) => panel.id === "success-collapsed",
    );
    const successExpanded = getToolPreviewPanels(scenario).find(
      (panel) => panel.id === "success-expanded",
    );
    const error = getToolPreviewPanels(scenario).find((panel) => panel.id === "error-collapsed");
    const errorExpanded = getToolPreviewPanels(scenario).find(
      (panel) => panel.id === "error-expanded",
    );

    expect(call).toBeTruthy();
    expect(callExpanded).toBeTruthy();
    expect(partial).toBeTruthy();
    expect(partialExpanded).toBeTruthy();
    expect(success).toBeTruthy();
    expect(successExpanded).toBeTruthy();
    expect(error).toBeTruthy();
    expect(errorExpanded).toBeTruthy();

    const callText = stripAnsi(renderPreviewText(scenario, call, 120));
    const callExpandedText = stripAnsi(renderPreviewText(scenario, callExpanded, 120));
    const partialText = stripAnsi(renderPreviewText(scenario, partial, 120));
    const animatedPartialText = stripAnsi(
      createPreviewComponent(scenario, partial, undefined, 2000).render(120).join("\n"),
    );
    const partialExpandedText = stripAnsi(renderPreviewText(scenario, partialExpanded, 120));
    const animatedPartialExpandedText = stripAnsi(
      createPreviewComponent(scenario, partialExpanded, undefined, 2000).render(120).join("\n"),
    );
    const successText = stripAnsi(renderPreviewText(scenario, success, 120));
    const successExpandedText = stripAnsi(renderPreviewText(scenario, successExpanded, 120));
    const errorText = stripAnsi(renderPreviewText(scenario, error, 120));
    const errorExpandedText = stripAnsi(renderPreviewText(scenario, errorExpanded, 120));

    expect(callText).toMatch(/executing List GitHub issues via executor/);
    expect(callText).toMatch(/17 lines so far/);
    expect(callText).toMatch(/status: "completed"/);
    expect(callExpandedText).toMatch(/const matches = await tools\.search/);
    expect(callExpandedText).toMatch(/const marker = "row\\x07";/);
    expect(callExpandedText).toMatch(/issues\.listForRepo/);
    expect(callExpandedText).not.toMatch(/\t/);

    expect(partialText).toMatch(/executing List GitHub issues via executor/);
    expect(partialText).toMatch(/"step": "search"|"step": "issues\.listForRepo"/);
    expect(partialText).toMatch(/executing · object · took 1s/);
    expect(animatedPartialText).toMatch(/issues\.listForRepo/);
    expect(partialExpandedText).toMatch(/"status": "executing"/);
    expect(partialExpandedText).toMatch(/"step": "search"|"step": "issues\.listForRepo"/);
    expect(animatedPartialExpandedText).toMatch(/"step": "issues\.listForRepo"/);

    expect(successText).toMatch(/executed List GitHub issues via executor/);
    expect(successText).toMatch(/completed · object · took 4s/);
    expect(successText).not.toMatch(/"content"/);
    expect(successExpandedText).toMatch(/const matches = await tools\.search/);
    expect(successExpandedText).toMatch(/"markdown": "Example Domain/);
    expect(successExpandedText).toMatch(/"statusCode": 200/);
    expect(successExpandedText).not.toMatch(/"content": \[/);

    expect(errorText).toMatch(/execute List GitHub issues via executor/);
    expect(errorText).toMatch(/failed · took 2s/);
    expect(errorExpandedText).toMatch(/ToolInvocationError/);
    expect(errorExpandedText).toMatch(/"error": "403 Forbidden"/);
  },
);

timedTest(
  "executor search results render markdown-style expanded view and suppress took 0s",
  () => {
    const scenario = getToolPreviewScenarios().find(
      (item) => item.id === "executor:search-results",
    );
    expect(scenario).toBeTruthy();

    const collapsed = getToolPreviewPanels(scenario).find(
      (panel) => panel.id === "success-collapsed",
    );
    const expanded = getToolPreviewPanels(scenario).find(
      (panel) => panel.id === "success-expanded",
    );

    expect(collapsed).toBeTruthy();
    expect(expanded).toBeTruthy();

    const collapsedText = stripAnsi(renderPreviewText(scenario, collapsed, 120));
    const expandedText = stripAnsi(renderPreviewText(scenario, expanded, 120));

    expect(collapsedText).toMatch(/executed Search firecrawl tools via executor/);
    expect(collapsedText).toMatch(/completed · matches\(2\)/);
    expect(collapsedText).not.toMatch(/took 0s/);

    expect(expandedText).toMatch(/1\. firecrawl_scrape/);
    expect(expandedText).toMatch(/Path: firecrawl\.firecrawl_scrape/);
    expect(expandedText).toMatch(/Source: firecrawl/);
    expect(expandedText).toMatch(/Score: 310/);
    expect(expandedText).toMatch(/Scrape content from a single URL\./);
    expect(expandedText).toMatch(/"url": "https:\/\/example\.com"/);
    expect(expandedText).toMatch(/2\. firecrawl_search/);
    expect(expandedText).not.toMatch(/"path": "firecrawl\.firecrawl_scrape"/);
  },
);

timedTest("multiline bash call preview truncates middle lines in collapsed mode", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "bash:multiline-call");
  expect(scenario).toBeTruthy();

  const collapsed = getToolPreviewPanels(scenario).find((panel) => panel.id === "call-collapsed");
  const expanded = getToolPreviewPanels(scenario).find((panel) => panel.id === "call-expanded");

  expect(collapsed).toBeTruthy();
  expect(expanded).toBeTruthy();

  const collapsedText = stripAnsi(renderPreviewText(scenario, collapsed, 120));
  const expandedText = stripAnsi(renderPreviewText(scenario, expanded, 120));

  expect(collapsedText).toMatch(/Reads package.json using multiline script/);
  expect(expandedText).toMatch(/node --import tsx - <<'EOF'/);
});

timedTest("failed multiline bash preview shows exit code on collapsed error", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "bash:multiline-call");
  expect(scenario).toBeTruthy();

  const error = getToolPreviewPanels(scenario).find((panel) => panel.id === "error-collapsed");
  expect(error).toBeTruthy();

  const text = stripAnsi(renderPreviewText(scenario, error, 120));

  expect(text).toMatch(/exit 1/);
});

timedTest("bash preview completion is sticky even when start marker is missing", () => {
  const toolDefinition = createBashToolOverrideDefinition(previewPi);
  const cwd = process.cwd().replaceAll(/\\/g, "/");
  const ui = { requestRender() {} };

  const createComponent = (toolCallId: string, description: string, markStarted = true) => {
    const component = new ToolExecutionComponent(
      "bash",
      toolCallId,
      {
        command: `echo ${description}`,
        description,
        timeout: 120,
      },
      {},
      toolDefinition,
      ui as never,
      cwd,
    );

    component.setExpanded(false);
    if (markStarted) {
      component.markExecutionStarted();
    }
    component.setArgsComplete();
    return component;
  };

  const finished = createComponent("bash-finished", "finished", false);
  const running = createComponent("bash-running", "running");
  const partialResult = {
    content: [{ type: "text", text: "line one\nline two" }],
  };

  finished.updateResult(partialResult, true);
  running.updateResult(partialResult, true);

  finished.updateResult({
    content: [{ type: "text", text: "line one\nline two\nexit code: 0" }],
    details: { durationMs: 1000 },
    isError: false,
  });

  finished.updateResult(partialResult, true);

  const renderedText = stripAnsi(finished.render(120).join("\n"));
  const nonEmptyLines = finished
    .render(120)
    .map((line) => stripAnsi(line))
    .filter((line) => line.trim().length > 0);

  expect(renderedText).toMatch(/finished · ok/);
  expect(renderedText).not.toMatch(/so far/);
  expect(nonEmptyLines.length).toBe(1);
});

timedTest("background bash preview renders background status instead of ok", () => {
  const toolDefinition = createBashToolOverrideDefinition(previewPi);
  const cwd = process.cwd().replaceAll(/\\/g, "/");
  const ui = { requestRender() {} };
  const component = new ToolExecutionComponent(
    "bash",
    "bash-background",
    {
      command: "npm run dev &",
      description: "Starts dev server",
    },
    {},
    toolDefinition,
    ui as never,
    cwd,
  );

  component.setExpanded(false);
  component.markExecutionStarted();
  component.setArgsComplete();
  component.updateResult({
    content: [{ type: "text", text: "Started background command in tmux window @1." }],
    details: { background: true },
    isError: false,
  });

  const renderedText = stripAnsi(component.render(120).join("\n"));
  expect(renderedText).toMatch(/Starts dev server · background/);
  expect(renderedText).not.toMatch(/ · ok/);
});

timedTest("tool previews render a bare left rail instead of a box wrapper", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "bash:compact");
  expect(scenario).toBeTruthy();

  const collapsed = getToolPreviewPanels(scenario).find(
    (panel) => panel.id === "success-collapsed",
  );
  expect(collapsed).toBeTruthy();

  const text = stripAnsi(renderPreviewText(scenario, collapsed, 120));

  expect(text).toMatch(/^\s*▏\s*\$/m);
});

timedTest(
  "interactive mode only spaces tool calls when a visible non-tool item interrupts them",
  () => {
    const cwd = process.cwd().replaceAll(/\\/g, "/");
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

      const lines = (mode as any).chatContainer
        .render(120)
        .map((line: string) => stripAnsi(line).trimEnd());
      const visibleLines = lines.filter((line: string) => line.trim().length > 0);

      const firstToolIndex = visibleLines.findIndex((line: string) => line.includes("a.ts"));
      const secondToolIndex = visibleLines.findIndex((line: string) => line.includes("b.ts"));
      const interruptIndex = visibleLines.findIndex((line: string) =>
        line.includes("Tool output interrupted."),
      );
      const thirdToolIndex = visibleLines.findIndex((line: string) => line.includes("c.ts"));

      expect(firstToolIndex).not.toBe(-1);
      expect(secondToolIndex).not.toBe(-1);
      expect(interruptIndex).not.toBe(-1);
      expect(thirdToolIndex).not.toBe(-1);
      expect(secondToolIndex - firstToolIndex).toBe(1);
      expect(thirdToolIndex - interruptIndex).toBe(1);
    } finally {
      (mode as any).footerDataProvider.dispose();
    }
  },
);

timedTest("compact tool previews use verb-first bold+dim statuses", () => {
  const expectations = [
    ["read:compact", "call-collapsed", /reading/],
    ["read:compact", "success-collapsed", /read/],
    ["edit:compact", "success-collapsed", /edited/],
    ["write:compact", "success-collapsed", /written/],
  ] as const;

  for (const [scenarioId, panelId, pattern] of expectations) {
    const scenario = getToolPreviewScenarios().find((item) => item.id === scenarioId);
    expect(scenario).toBeTruthy();
    const panel = getToolPreviewPanels(scenario).find((item) => item.id === panelId);
    expect(panel).toBeTruthy();
    expect(stripAnsi(renderPreviewText(scenario, panel, 120))).toMatch(pattern);
  }
});

timedTest("grouped read batch preview renders collapsed and expanded summaries", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "read:batch");
  expect(scenario).toBeTruthy();

  const collapsed = getToolPreviewPanels(scenario).find(
    (panel) => panel.id === "success-collapsed",
  );
  const expanded = getToolPreviewPanels(scenario).find((panel) => panel.id === "success-expanded");

  expect(collapsed).toBeTruthy();
  expect(expanded).toBeTruthy();

  const collapsedText = renderPreviewText(scenario, collapsed, 120);
  const expandedText = renderPreviewText(scenario, expanded, 120);

  expect(stripAnsi(collapsedText)).toMatch(/batched 3 reads/);
  expect(stripAnsi(collapsedText)).toMatch(/README\.md/);
  expect(stripAnsi(expandedText)).toMatch(/read \.\/README\.md/);
  expect(stripAnsi(expandedText)).toMatch(/read \.\/src\/extensions\/patch\.ts/);
});

timedTest("read SKILL.md renders as skill verb with skill name", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "read:skill-file");
  expect(scenario).toBeTruthy();

  const call = getToolPreviewPanels(scenario).find((panel) => panel.id === "call-collapsed");
  const success = getToolPreviewPanels(scenario).find((panel) => panel.id === "success-collapsed");
  expect(call).toBeTruthy();
  expect(success).toBeTruthy();

  const callText = stripAnsi(renderPreviewText(scenario, call, 120));
  const successText = stripAnsi(renderPreviewText(scenario, success, 120));

  expect(callText).toMatch(/reading.*git-commiting/);
  expect(successText).toMatch(/skill git-commiting/);
  expect(callText).not.toMatch(/SKILL\.md/);
  expect(successText).not.toMatch(/SKILL\.md/);
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
    getThemeSetting: () => "dark",
    getShowImages: () => false,
    getImageWidthCells: () => 60,
    getCodeBlockIndent: () => 2,
  };
  const sessionManager = {
    getCwd: () => cwd,
    getEntries: () => [],
    getSessionName: () => {},
  };
  const session = {
    autoCompactionEnabled: false,
    sessionManager,
    settingsManager,
    resourceLoader: {
      getThemes: () => ({ themes: [] }),
      getSkills: () => ({ skills: [] }),
    },
    getToolDefinition: (toolName: string) =>
      toolName === readToolDefinition.name ? readToolDefinition : undefined,
    state: { messages: [] },
  };

  return new InteractiveMode({
    session,
    dispose: async () => {},
    setBeforeSessionInvalidate: () => {},
    setRebindSession: () => {},
  } as never);
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
