import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { saveConfig } from "./config.js";
import { startPrunerWidget } from "./progress-widget.js";
import { setContextPruneFooterState } from "./public-api.js";
import { registerSummaryRenderer } from "./renderer.js";
import { showSettingsOverlay } from "./settings-overlay.js";
import { formatCost, formatTokens } from "./stats.js";
import { buildPruneTree, TreeBrowser } from "./tree-browser.js";
import type { ToolCallIndexer } from "./indexer.js";
import {
  BATCHING_MODES,
  PRUNE_ON_MODES,
  SUMMARIZER_THINKING_LEVELS,
  type CapturedBatch,
  type ContextPruneConfig,
  type FlushOptions,
  type SummarizerStats,
} from "./types.js";

type FlushResult =
  | {
      ok: true;
      reason: "flushed" | "skipped-oversized" | "skipped-undersized";
      batchCount: number;
      toolCallCount: number;
      rawCharCount: number;
      summaryCharCount: number;
    }
  | { ok: false; reason: string; error?: string };

type FlushPending = (ctx: ExtensionCommandContext, options?: FlushOptions) => Promise<FlushResult>;

interface CommandRuntime {
  currentConfig: { value: ContextPruneConfig };
  flushPending: FlushPending;
  capturePendingBatches: (ctx: ExtensionCommandContext) => CapturedBatch[];
  syncToolActivation: () => void;
  getStats: () => SummarizerStats;
  indexer: ToolCallIndexer;
}

const SUBCOMMANDS = [
  { value: "settings", label: "settings  — show current settings" },
  { value: "on", label: "on        — enable context pruning" },
  { value: "off", label: "off       — disable context pruning" },
  { value: "status", label: "status    — show status" },
  { value: "model", label: "model     — show or set summarizer model" },
  { value: "thinking", label: "thinking  — show or set thinking level" },
  { value: "prune-on", label: "prune-on  — show or set trigger mode" },
  { value: "batching", label: "batching  — show or set batching mode" },
  { value: "stats", label: "stats     — show summarizer stats" },
  { value: "tree", label: "tree      — browse pruned tool calls" },
  { value: "now", label: "now       — flush pending tool calls" },
  { value: "help", label: "help      — show help" },
] as const;

const HELP_TEXT = `pruner — summarizes tool-call outputs to keep context lean.

Usage:
  /pruner on|off|status|settings|stats|tree|now|help
  /pruner model [model-id[:thinking]]
  /pruner thinking [default|off|minimal|low|medium|high|xhigh]
  /pruner prune-on [every-turn|on-context-tag|on-demand|agent-message|agentic-auto]
  /pruner batching [turn|agent-message]`;

export function pruneStatusText(config: ContextPruneConfig, stats?: SummarizerStats): string {
  const mode =
    PRUNE_ON_MODES.find((entry) => entry.value === config.pruneOn)?.label ?? config.pruneOn;
  const base = `prune: ${config.enabled ? "ON" : "OFF"} (${mode})`;
  if (stats === undefined || stats.callCount === 0) {
    return base;
  }
  return `${base} │ ↑${formatTokens(stats.totalInputTokens)} ↓${formatTokens(stats.totalOutputTokens)} ${formatCost(stats.totalCost)}`;
}

export function setPruneStatusWidget(
  _ctx: unknown,
  config: ContextPruneConfig,
  value?: SummarizerStats | string,
): void {
  if (!config.showPruneStatusLine) {
    setContextPruneFooterState(undefined);
    return;
  }
  setContextPruneFooterState({
    config,
    stats: typeof value === "string" ? undefined : value,
    overrideText: typeof value === "string" ? value : undefined,
    pendingBatchCount: 0,
  });
}

export function registerCommands(
  pi: ExtensionAPI,
  currentConfig: { value: ContextPruneConfig },
  flushPending: FlushPending,
  capturePendingBatches: (ctx: ExtensionCommandContext) => CapturedBatch[],
  syncToolActivation: () => void,
  getStats: () => SummarizerStats,
  indexer: ToolCallIndexer,
): void {
  const runtime = {
    currentConfig,
    flushPending,
    capturePendingBatches,
    syncToolActivation,
    getStats,
    indexer,
  };
  pi.registerCommand("pruner", {
    description: "Context-prune settings and commands",
    getArgumentCompletions: (prefix) =>
      SUBCOMMANDS.filter((entry) => entry.value.startsWith(prefix)),
    handler: (args, ctx) => handlePrunerCommand(args, ctx, runtime),
  });
  registerSummaryRenderer(pi);
}

async function handlePrunerCommand(
  args: string,
  ctx: ExtensionCommandContext,
  runtime: CommandRuntime,
): Promise<void> {
  const [rawSubcommand, ...subArgs] = args
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  const subcommand = rawSubcommand ?? (await chooseSubcommand(ctx));
  if (subcommand === undefined) return;
  const handlers: Record<string, () => Promise<void> | void> = {
    settings: () => {
      showSettings(ctx, runtime);
    },
    on: () => {
      setEnabled(ctx, runtime, true);
    },
    off: () => {
      setEnabled(ctx, runtime, false);
    },
    status: () => {
      showStatus(ctx, runtime);
    },
    model: () => {
      setModel(ctx, runtime, subArgs[0]);
    },
    thinking: () => {
      setThinking(ctx, runtime, subArgs[0]);
    },
    "prune-on": () => setPruneOn(ctx, runtime, subArgs[0]),
    batching: () => setBatching(ctx, runtime, subArgs[0]),
    stats: () => {
      showStats(ctx, runtime.getStats());
    },
    tree: () => showTree(ctx, runtime.indexer),
    now: () => flushNow(ctx, runtime),
    help: () => {
      ctx.ui.notify(HELP_TEXT);
    },
  };
  const handler = handlers[subcommand];
  if (handler === undefined) {
    ctx.ui.notify(`Unknown subcommand: "${subcommand}". Run /pruner help for usage.`, "warning");
    return;
  }
  const result = handler();
  if (result instanceof Promise) {
    await result;
  }
}

async function chooseSubcommand(ctx: ExtensionCommandContext): Promise<string | undefined> {
  const choice = await ctx.ui.select(
    "pruner — choose a subcommand",
    SUBCOMMANDS.map((entry) => entry.label),
  );
  return choice?.split(/\s+/)[0];
}

function persistConfig(ctx: ExtensionCommandContext, runtime: CommandRuntime): void {
  void saveConfig(runtime.currentConfig.value);
  setPruneStatusWidget(ctx, runtime.currentConfig.value, runtime.getStats());
  runtime.syncToolActivation();
}

function setEnabled(ctx: ExtensionCommandContext, runtime: CommandRuntime, enabled: boolean): void {
  runtime.currentConfig.value = { ...runtime.currentConfig.value, enabled };
  persistConfig(ctx, runtime);
  ctx.ui.notify(`Context pruning ${enabled ? "enabled" : "disabled"}.`);
}

function showSettings(ctx: ExtensionCommandContext, runtime: CommandRuntime): void {
  void showSettingsOverlay(ctx, runtime);
}

function showStatus(ctx: ExtensionCommandContext, runtime: CommandRuntime): void {
  const config = runtime.currentConfig.value;
  const stats = runtime.getStats();
  ctx.ui.notify(`${showStatusConfig(config)}${statsText(stats)}`);
}

function showStatusConfig(config: ContextPruneConfig): string {
  const mode =
    PRUNE_ON_MODES.find((entry) => entry.value === config.pruneOn)?.label ?? config.pruneOn;
  return `pruner status:\n  enabled:  ${config.enabled}\n  models:   ${config.summarizerModels.join(", ")}\n  thinking: ${config.summarizerThinking}\n  trigger:  ${mode}\n  batching: ${config.batchingMode}\n  min raw:  ${config.minRawCharsToPrune} chars\n  status:   ${config.showPruneStatusLine ? "on" : "off"}\n  remind:   ${config.remindUnprunedCount ? "on" : "off"}`;
}

function statsText(stats: SummarizerStats): string {
  if (stats.callCount === 0) return "\n  (no summarizer calls yet)";
  return `\n  --- summarizer ---\n  calls:       ${stats.callCount}\n  input:       ${formatTokens(stats.totalInputTokens)} tokens\n  output:      ${formatTokens(stats.totalOutputTokens)} tokens\n  cost:        ${formatCost(stats.totalCost)}`;
}

function parseModelAndThinking(
  value: string,
): { model: string; thinking?: ContextPruneConfig["summarizerThinking"] } | string {
  const separatorIndex = value.lastIndexOf(":");
  if (separatorIndex === -1) return { model: value };
  const model = value.slice(0, separatorIndex);
  const thinking = value.slice(separatorIndex + 1);
  if (model.length === 0 || !isThinkingValue(thinking)) {
    return `Invalid model thinking suffix: ${thinking}. Use one of: ${SUMMARIZER_THINKING_LEVELS.map((level) => level.value).join(", ")}.`;
  }
  return { model, thinking };
}

function setModel(
  ctx: ExtensionCommandContext,
  runtime: CommandRuntime,
  value: string | undefined,
): void {
  if (value === undefined) {
    ctx.ui.notify(
      `Current summarizer models: ${runtime.currentConfig.value.summarizerModels.join(", ")}`,
    );
    return;
  }
  const parsed = parseModelAndThinking(value);
  if (typeof parsed === "string") {
    ctx.ui.notify(parsed, "warning");
    return;
  }
  runtime.currentConfig.value = {
    ...runtime.currentConfig.value,
    summarizerModels: [parsed.model],
    summarizerThinking: parsed.thinking ?? runtime.currentConfig.value.summarizerThinking,
  };
  persistConfig(ctx, runtime);
  ctx.ui.notify(`Summarizer model set to: ${parsed.model}`);
}

function setThinking(
  ctx: ExtensionCommandContext,
  runtime: CommandRuntime,
  value: string | undefined,
): void {
  if (value === undefined) {
    ctx.ui.notify(`Current summarizer thinking: ${runtime.currentConfig.value.summarizerThinking}`);
    return;
  }
  if (!isThinkingValue(value)) {
    ctx.ui.notify(`Invalid summarizer thinking level: ${value}.`, "warning");
    return;
  }
  runtime.currentConfig.value = { ...runtime.currentConfig.value, summarizerThinking: value };
  persistConfig(ctx, runtime);
  ctx.ui.notify(`Summarizer thinking set to: ${value}`);
}

async function setPruneOn(
  ctx: ExtensionCommandContext,
  runtime: CommandRuntime,
  value: string | undefined,
): Promise<void> {
  const selected = value ?? (await chooseValue(ctx, "pruner — choose trigger", PRUNE_ON_MODES));
  if (selected === undefined) return;
  if (!isPruneOnValue(selected)) {
    ctx.ui.notify(`Invalid prune trigger: ${selected}.`, "warning");
    return;
  }
  runtime.currentConfig.value = { ...runtime.currentConfig.value, pruneOn: selected };
  persistConfig(ctx, runtime);
}

async function setBatching(
  ctx: ExtensionCommandContext,
  runtime: CommandRuntime,
  value: string | undefined,
): Promise<void> {
  const selected = value ?? (await chooseValue(ctx, "pruner — choose batching", BATCHING_MODES));
  if (selected === undefined) return;
  if (!isBatchingValue(selected)) {
    ctx.ui.notify(`Invalid batching mode: ${selected}.`, "warning");
    return;
  }
  runtime.currentConfig.value = { ...runtime.currentConfig.value, batchingMode: selected };
  persistConfig(ctx, runtime);
  ctx.ui.notify(`Batching mode set to: ${selected}`);
}

async function chooseValue(
  ctx: ExtensionCommandContext,
  title: string,
  entries: readonly { value: string; label: string }[],
): Promise<string | undefined> {
  const choice = await ctx.ui.select(
    title,
    entries.map((entry) => `${entry.value} — ${entry.label}`),
  );
  return choice?.split(/\s+/)[0];
}

function showStats(ctx: ExtensionCommandContext, stats: SummarizerStats): void {
  ctx.ui.notify(`pruner stats:${statsText(stats)}`);
}

async function showTree(ctx: ExtensionCommandContext, indexer: ToolCallIndexer): Promise<void> {
  const roots = buildPruneTree(ctx, indexer);
  if (roots.length === 0) {
    ctx.ui.notify("No pruned tool calls found in this session.", "info");
    return;
  }
  await ctx.ui.custom(
    (_tui, theme, _keybindings, done) =>
      new TreeBrowser(roots, theme, () => {
        done(null);
      }),
    {
      overlay: true,
      overlayOptions: { width: "80%", maxHeight: "70%", anchor: "center" },
    },
  );
}

async function flushNow(ctx: ExtensionCommandContext, runtime: CommandRuntime): Promise<void> {
  if (!runtime.currentConfig.value.enabled) {
    ctx.ui.notify("Context pruning is disabled. Run /pruner on first.", "warning");
    return;
  }
  const batches = runtime.capturePendingBatches(ctx);
  if (batches.length === 0) {
    ctx.ui.notify("pruner: nothing pending — no batches to summarize", "info");
    return;
  }
  const widget = startPrunerWidget(ctx, batches);
  const result = await runtime.flushPending(ctx, {
    previewedBatches: batches,
    onProgress: (index, _total, _batch, stage) => {
      widget.updateRow(index, progressStageStatus(stage));
    },
    onBatchTextProgress: (index, _total, _batch, receivedChars) => {
      widget.updateRow(index, "running", receivedChars);
    },
  });
  widget.clearWidget();
  setPruneStatusWidget(ctx, runtime.currentConfig.value, runtime.getStats());
  notifyFlushResult(ctx, result);
}

function progressStageStatus(stage: "start" | "done" | "skipped"): "running" | "done" | "skipped" {
  if (stage === "start") return "running";
  if (stage === "done") return "done";
  return "skipped";
}

function notifyFlushResult(ctx: ExtensionCommandContext, result: FlushResult): void {
  if (!result.ok) {
    const suffix = result.error === undefined ? "" : ` (${result.error})`;
    ctx.ui.notify(
      `pruner: nothing flushed — ${result.reason}${suffix}`,
      result.reason === "empty" ? "info" : "warning",
    );
    return;
  }
  if (result.reason === "skipped-oversized") {
    ctx.ui.notify(
      `pruner: skipped pruning ${result.toolCallCount} tool calls — summary was ${result.summaryCharCount} chars vs ${result.rawCharCount} raw chars`,
      "warning",
    );
  }
}

function isThinkingValue(value: string): value is ContextPruneConfig["summarizerThinking"] {
  return SUMMARIZER_THINKING_LEVELS.some((entry) => entry.value === value);
}

function isPruneOnValue(value: string): value is ContextPruneConfig["pruneOn"] {
  return PRUNE_ON_MODES.some((entry) => entry.value === value);
}

function isBatchingValue(value: string): value is ContextPruneConfig["batchingMode"] {
  return BATCHING_MODES.some((entry) => entry.value === value);
}
