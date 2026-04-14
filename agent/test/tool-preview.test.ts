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

const timedTest: typeof test = ((name: string, fn: (...args: any[]) => any) =>
  test(name, { timeout: TEST_TIMEOUT_MS }, fn)) as typeof test;

timedTest("apply_patch preview renders collapsed and expanded states", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "apply_patch:multi-file");
  assert.ok(scenario);

  const collapsed = getToolPreviewPanels(scenario).find(
    (panel) => panel.id === "success-collapsed",
  );
  const partial = getToolPreviewPanels(scenario).find((panel) => panel.id === "partial-collapsed");
  const error = getToolPreviewPanels(scenario).find((panel) => panel.id === "error-expanded");
  const expanded = getToolPreviewPanels(scenario).find((panel) => panel.id === "success-expanded");

  assert.ok(collapsed);
  assert.ok(partial);
  assert.ok(error);
  assert.ok(expanded);

  const collapsedText = renderPreviewText(scenario, collapsed, 120);
  const collapsedLines = renderPreviewLines(scenario, collapsed, 120).filter(
    (line) => stripAnsi(line).trim().length > 0,
  );
  const partialText = renderPreviewText(scenario, partial, 120);
  const errorText = renderPreviewText(scenario, error, 120);
  const expandedText = renderPreviewText(scenario, expanded, 120);

  assert.match(stripAnsi(partialText), /patching 4 files/);
  assert.match(stripAnsi(partialText), /0\/4/);
  assert.match(stripAnsi(partialText), /src\/extensions\/patch.ts/);
  assert.equal(collapsedLines.length, 1);
  assert.match(stripAnsi(collapsedText), /patched 4 files/);
  assert.match(stripAnsi(collapsedText), /\+\d+ -\d+/);
  assert.doesNotMatch(stripAnsi(collapsedText), /↳/);
  assert.doesNotMatch(stripAnsi(collapsedText), /A src\/tool-preview-demo.ts/);
  assert.doesNotMatch(stripAnsi(collapsedText), /D src\/tool-preview-old.ts/);
  assert.match(stripAnsi(errorText), /patch 4 files/);
  assert.match(stripAnsi(errorText), /src\/tool-preview-modern.ts/);
  assert.match(stripAnsi(expandedText), /M src\/extensions\/patch.ts/);
  assert.match(stripAnsi(expandedText), /A src\/tool-preview-demo.ts/);
  assert.match(
    stripAnsi(expandedText),
    /diff --git a\/src\/extensions\/patch.ts b\/src\/extensions\/patch.ts/,
  );
  assert.doesNotMatch(stripAnsi(expandedText), /\*\*\* Update File:/);
});

timedTest("single-file patch collapsed success avoids duplicate summary line", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "apply_patch:single-file");
  assert.ok(scenario);

  const collapsed = getToolPreviewPanels(scenario).find(
    (panel) => panel.id === "success-collapsed",
  );
  assert.ok(collapsed);

  const text = stripAnsi(renderPreviewText(scenario, collapsed, 120));
  assert.match(text, /patched patch\.ts \.\/src\/extensions\/ · \+\d+ -\d+/);
  assert.doesNotMatch(text, /↳/);
});

timedTest("streaming apply_patch call shows incoming patch lines", () => {
  const scenario = getToolPreviewScenarios().find(
    (item) => item.id === "apply_patch:streaming-call",
  );
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

  assert.match(text, /patched patch\.ts \.\/src\/extensions\/ · \+\d+ -\d+/);
  assert.doesNotMatch(text, /\bpatching\b/);
  assert.doesNotMatch(text, /\*\*\* Update File:/);
});

timedTest("session_query preview appends collapsed result inline", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "session_query:compact");
  assert.ok(scenario);

  const collapsed = getToolPreviewPanels(scenario).find(
    (panel) => panel.id === "success-collapsed",
  );
  const partial = getToolPreviewPanels(scenario).find((panel) => panel.id === "partial-collapsed");
  const expanded = getToolPreviewPanels(scenario).find((panel) => panel.id === "success-expanded");

  assert.ok(collapsed);
  assert.ok(partial);
  assert.ok(expanded);

  const collapsedText = stripAnsi(renderPreviewText(scenario, collapsed, 120));
  const collapsedLines = renderPreviewLines(scenario, collapsed, 120).filter(
    (line) => stripAnsi(line).trim().length > 0,
  );
  const partialText = stripAnsi(renderPreviewText(scenario, partial, 120));
  const expandedText = stripAnsi(renderPreviewText(scenario, expanded, 120));

  assert.equal(collapsedLines.length, 1);
  assert.match(
    collapsedText,
    /queried 0e990a27 → What files were modified in the parent session\?/,
  );
  assert.match(collapsedText, /answered · took \d+s/);
  assert.doesNotMatch(collapsedText, /↳/);
  assert.match(partialText, /Modified files included src\/extensions\/coreui\/tools.ts/);
  assert.match(partialText, /1 line so far \(0s\)/);
  assert.match(expandedText, /Question:/);
  assert.match(expandedText, /test\/tool-preview.test.ts/);
});

timedTest("subagent previews render representative action summaries and expanded metadata", () => {
  const startScenario = getToolPreviewScenarios().find((item) => item.id === "subagent:start");
  const messageScenario = getToolPreviewScenarios().find((item) => item.id === "subagent:message");
  const listScenario = getToolPreviewScenarios().find((item) => item.id === "subagent:list");
  const cancelScenario = getToolPreviewScenarios().find((item) => item.id === "subagent:cancel");

  assert.ok(startScenario);
  assert.ok(messageScenario);
  assert.ok(listScenario);
  assert.ok(cancelScenario);

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

  assert.ok(startCollapsed);
  assert.ok(startExpanded);
  assert.ok(startPartialCollapsed);
  assert.ok(startPartialExpanded);
  assert.ok(messagePartialCollapsed);
  assert.ok(messagePartialExpanded);
  assert.ok(messageCollapsed);
  assert.ok(messageExpanded);
  assert.ok(listCollapsed);
  assert.ok(listExpanded);
  assert.ok(cancelCollapsed);
  assert.ok(cancelExpanded);

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

  assert.match(
    startCollapsedText,
    /π start · reviewer-two · review · Review preview renderer and note UI gaps · reviewer-two · running/,
  );
  assert.match(startPartialCollapsedText, /π start .* · handoff/s);
  assert.match(startPartialExpandedText, /Preparing handoff for reviewer-two/);
  assert.match(startPartialExpandedText, /0s/);
  assert.match(animatedStartPartialCollapsedText, /\.\.\. \(2 earlier lines\)/);
  assert.match(animatedStartPartialCollapsedText, /7 lines so far \(2s\) · handoff/);
  assert.match(animatedStartPartialCollapsedText, /SUBAGENT-TAIL-MARKER/);
  assert.match(animatedStartPartialCollapsedText, /visible\./);
  assert.doesNotMatch(
    animatedStartPartialCollapsedText,
    /We implemented tmux-backed subagents with session-backed persistence\./,
  );
  assert.match(animatedStartPartialExpandedText, /## Context/);
  assert.match(
    animatedStartPartialExpandedText,
    /We implemented tmux-backed subagents with session-backed persistence\./,
  );
  assert.match(animatedStartPartialExpandedText, /handoff · 2s/);
  assert.match(animatedStartPartialExpandedText, /keep SUBAGENT-TAIL-MARKER/);
  assert.match(animatedStartPartialExpandedText, /visible\./);
  assert.match(startExpandedText, /name: reviewer-two/);
  assert.match(startExpandedText, /handoff: true/);
  assert.match(startExpandedText, /prompt:/);
  assert.match(startExpandedText, /promptGuidance:/);
  assert.match(
    startExpandedText,
    /The subagent will return with a summary automatically when it.*finishes/is,
  );
  assert.match(startExpandedText, /sessionPath: .*2d2c7b0c\.jsonl/);

  assert.match(messagePartialCollapsedText, /1 line so far \(0s\) · message followUp/);
  assert.match(messagePartialExpandedText, /Ping/);
  assert.match(animatedMessagePartialCollapsedText, /2 lines so far \(1s\) · message followUp/);
  assert.match(animatedMessagePartialExpandedText, /Ping/);
  assert.match(animatedMessagePartialExpandedText, /Spacing\?/);
  assert.match(animatedMessagePartialExpandedText, /message followUp · 1s/);
  const messageCollapsedLines = renderPreviewLines(messageScenario, messageCollapsed, 120).filter(
    (line) => stripAnsi(line).trim().length > 0,
  );
  assert.equal(messageCollapsedLines.length, 1);
  assert.match(messageCollapsedText, /π message · 92ad1c07 · followUp · Ping Spacing\?/);
  assert.match(messageCollapsedText, /doc-writer · running · followUp · Ping Spacing\?/);
  assert.match(messageExpandedText, /delivery: followUp/);
  assert.match(messageExpandedText, /message:/);
  assert.match(messageExpandedText, /Ping/);
  assert.match(messageExpandedText, /Spacing\?/);

  assert.match(
    listCollapsedText,
    /π list · 5 agents · 1 running · 1 idle · 1 completed · 1 cancelled · 1 failed/,
  );
  assert.match(listExpandedText, /count: 5/);
  assert.match(listExpandedText, /subagent 1:/);
  assert.match(listExpandedText, /name: worker-epsilon/);
  assert.match(listExpandedText, /exitCode: 1/);

  assert.match(cancelCollapsedText, /π cancel · c91e7f44 · stuck-worker · cancelled/);
  assert.match(cancelExpandedText, /status: cancelled/);
  assert.match(cancelExpandedText, /completedAt: 2026-04-11T18:16:00.000Z/);
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
    assert.ok(scenario);
    const panel = getToolPreviewPanels(scenario).find((item) => item.id === "error-collapsed");
    assert.ok(panel);
    const text = stripAnsi(renderPreviewText(scenario, panel, 120));
    assert.match(text, headerPattern);
    assert.match(text, bodyPattern);
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
  assert.ok(scenario);

  const collapsed = getToolPreviewPanels(scenario).find(
    (panel) => panel.id === "success-collapsed",
  );
  const error = getToolPreviewPanels(scenario).find((panel) => panel.id === "error-collapsed");
  const expanded = getToolPreviewPanels(scenario).find((panel) => panel.id === "success-expanded");

  assert.ok(collapsed);
  assert.ok(error);
  assert.ok(expanded);

  const collapsedText = renderPreviewText(scenario, collapsed, 120);
  const collapsedLines = renderPreviewLines(scenario, collapsed, 120).filter(
    (line) => stripAnsi(line).trim().length > 0,
  );
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
  assert.match(
    stripAnsi(expandedText),
    /apply_patch preview renders collapsed and expanded states/,
  );
});

timedTest("webfetch preview renders pending, collapsed status, and expanded body", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "webfetch:compact");
  assert.ok(scenario);

  const pending = getToolPreviewPanels(scenario).find((panel) => panel.id === "partial-collapsed");
  const collapsed = getToolPreviewPanels(scenario).find(
    (panel) => panel.id === "success-collapsed",
  );
  const expanded = getToolPreviewPanels(scenario).find((panel) => panel.id === "success-expanded");
  const error = getToolPreviewPanels(scenario).find((panel) => panel.id === "error-collapsed");

  assert.ok(pending);
  assert.ok(collapsed);
  assert.ok(expanded);
  assert.ok(error);

  const pendingText = stripAnsi(renderPreviewText(scenario, pending, 120));
  const animatedPendingText = stripAnsi(
    createPreviewComponent(scenario, pending, undefined, 2000).render(120).join("\n"),
  );
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
  assert.match(
    expandedText,
    /Full output saved to: \/tmp\/pi-fetch-preview\.txt|Full output saved to: \/tmp\/pi-webfetch-/,
  );
  assert.match(errorText, /fetch https:\/\/example\.com\/docs\/pi\/fetch-preview/);
});

timedTest(
  "websearch preview renders call, collapsed grounded summary, expanded sources, and error",
  () => {
    const scenario = getToolPreviewScenarios().find(
      (item) => item.id === "websearch:grounded-answer",
    );
    assert.ok(scenario);

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

    assert.ok(call);
    assert.ok(pending);
    assert.ok(pendingExpanded);
    assert.ok(collapsed);
    assert.ok(expanded);
    assert.ok(error);

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

    assert.match(callText, /googling When did Next\.js 16 release and what changed\?/);
    assert.match(callText, /gemini-2\.5-flash/);
    assert.match(callText, /30s/);
    assert.match(pendingText, /googling When did Next\.js 16 release and what changed\?/);
    assert.match(pendingText, /Next\.js 16 released in October 2025/);
    assert.match(pendingText, /1 line so far \(0s\)/);
    assert.match(animatedPendingText, /\.{3} \(2 earlier lines\)/);
    assert.match(animatedPendingText, /7 lines so far \(2s\)/);
    assert.match(pendingExpandedText, /Next\.js 16 released in October 2025/);
    assert.match(
      animatedPendingExpandedText,
      /The upgrade guide also replaces ppr with cacheComponents/,
    );
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
  },
);

timedTest("websearch minimal preview omits source and query counts", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "websearch:minimal-answer");
  assert.ok(scenario);

  const collapsed = getToolPreviewPanels(scenario).find(
    (panel) => panel.id === "success-collapsed",
  );
  assert.ok(collapsed);

  const text = stripAnsi(renderPreviewText(scenario, collapsed, 120));

  assert.match(text, /googled Has Bun 1\.3\.0 released yet\?/);
  assert.match(text, /gemini-2\.5-flash-lite/);
  assert.match(text, /answered · 0 grounded results · took 3s/);
});

timedTest(
  "executor preview renders compact call, highlighted code, json result, and error states",
  () => {
    const scenario = getToolPreviewScenarios().find((item) => item.id === "executor:compact");
    assert.ok(scenario);

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

    assert.ok(call);
    assert.ok(callExpanded);
    assert.ok(partial);
    assert.ok(partialExpanded);
    assert.ok(success);
    assert.ok(successExpanded);
    assert.ok(error);
    assert.ok(errorExpanded);

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

    assert.match(callText, /executing List GitHub issues via executor/);
    assert.match(callText, /17 lines so far/);
    assert.match(callText, /status: "completed"/);
    assert.match(callExpandedText, /const matches = await tools\.search/);
    assert.match(callExpandedText, /const marker = "row\\x07";/);
    assert.match(callExpandedText, /issues\.listForRepo/);
    assert.doesNotMatch(callExpandedText, /\t/);

    assert.match(partialText, /executing List GitHub issues via executor/);
    assert.match(partialText, /"step": "search"|"step": "issues\.listForRepo"/);
    assert.match(partialText, /executing · object · took 1s/);
    assert.match(animatedPartialText, /issues\.listForRepo/);
    assert.match(partialExpandedText, /"status": "executing"/);
    assert.match(partialExpandedText, /"step": "search"|"step": "issues\.listForRepo"/);
    assert.match(animatedPartialExpandedText, /"step": "issues\.listForRepo"/);

    assert.match(successText, /executed List GitHub issues via executor/);
    assert.match(successText, /completed · object · took 4s/);
    assert.doesNotMatch(successText, /"content"/);
    assert.match(successExpandedText, /const matches = await tools\.search/);
    assert.match(successExpandedText, /"markdown": "Example Domain/);
    assert.match(successExpandedText, /"statusCode": 200/);
    assert.doesNotMatch(successExpandedText, /"content": \[/);

    assert.match(errorText, /execute List GitHub issues via executor/);
    assert.match(errorText, /failed · took 2s/);
    assert.match(errorExpandedText, /ToolInvocationError/);
    assert.match(errorExpandedText, /"error": "403 Forbidden"/);
  },
);

timedTest(
  "executor search results render markdown-style expanded view and suppress took 0s",
  () => {
    const scenario = getToolPreviewScenarios().find(
      (item) => item.id === "executor:search-results",
    );
    assert.ok(scenario);

    const collapsed = getToolPreviewPanels(scenario).find(
      (panel) => panel.id === "success-collapsed",
    );
    const expanded = getToolPreviewPanels(scenario).find(
      (panel) => panel.id === "success-expanded",
    );

    assert.ok(collapsed);
    assert.ok(expanded);

    const collapsedText = stripAnsi(renderPreviewText(scenario, collapsed, 120));
    const expandedText = stripAnsi(renderPreviewText(scenario, expanded, 120));

    assert.match(collapsedText, /executed Search firecrawl tools via executor/);
    assert.match(collapsedText, /completed · matches\(2\)/);
    assert.doesNotMatch(collapsedText, /took 0s/);

    assert.match(expandedText, /1\. firecrawl_scrape/);
    assert.match(expandedText, /Path: firecrawl\.firecrawl_scrape/);
    assert.match(expandedText, /Source: firecrawl/);
    assert.match(expandedText, /Score: 310/);
    assert.match(expandedText, /Scrape content from a single URL\./);
    assert.match(expandedText, /"url": "https:\/\/example\.com"/);
    assert.match(expandedText, /2\. firecrawl_search/);
    assert.doesNotMatch(expandedText, /"path": "firecrawl\.firecrawl_scrape"/);
  },
);

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

  const collapsed = getToolPreviewPanels(scenario).find(
    (panel) => panel.id === "success-collapsed",
  );
  assert.ok(collapsed);

  const text = stripAnsi(renderPreviewText(scenario, collapsed, 120));

  assert.match(text, /^\s*▏\s*\$/m);
});

timedTest(
  "interactive mode only spaces tool calls when a visible non-tool item interrupts them",
  () => {
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

      const lines = (mode as any).chatContainer
        .render(120)
        .map((line: string) => stripAnsi(line).trimEnd());

      const firstToolIndex = lines.findIndex((line: string) => line.includes("a.ts"));
      const secondToolIndex = lines.findIndex((line: string) => line.includes("b.ts"));
      const interruptIndex = lines.findIndex((line: string) =>
        line.includes("Tool output interrupted."),
      );
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
    assert.ok(scenario);
    const panel = getToolPreviewPanels(scenario).find((item) => item.id === panelId);
    assert.ok(panel);
    assert.match(stripAnsi(renderPreviewText(scenario, panel, 120)), pattern);
  }
});

timedTest("grouped read batch preview renders collapsed and expanded summaries", () => {
  const scenario = getToolPreviewScenarios().find((item) => item.id === "read:batch");
  assert.ok(scenario);

  const collapsed = getToolPreviewPanels(scenario).find(
    (panel) => panel.id === "success-collapsed",
  );
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
    getToolDefinition: (toolName: string) =>
      toolName === readToolDefinition.name ? readToolDefinition : undefined,
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
