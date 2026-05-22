import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, type SettingItem } from "@earendil-works/pi-tui";
import { saveConfig } from "./config.js";
import { setPruneStatusWidget } from "./commands.js";
import type { SummarizerStats, ContextPruneConfig } from "./types.js";
import { BATCHING_MODES, PRUNE_ON_MODES, SUMMARIZER_THINKING_LEVELS } from "./types.js";

export interface SettingsOverlayRuntime {
  currentConfig: { value: ContextPruneConfig };
  getStats: () => SummarizerStats;
  syncToolActivation: () => void;
}

class SettingsOverlay extends Container {
  constructor(
    title: string,
    private readonly settingsList: SettingsList,
  ) {
    super();
    this.addChild(new DynamicBorder());
    this.addChild(new Text(title, 0, 0));
    this.addChild(settingsList);
    this.addChild(new DynamicBorder());
  }

  handleInput(data: string): void {
    this.settingsList.handleInput(data);
  }

  invalidate(): void {
    this.settingsList.invalidate();
  }
}

export async function showSettingsOverlay(
  ctx: ExtensionCommandContext,
  runtime: SettingsOverlayRuntime,
): Promise<void> {
  const items = buildSettingItems(ctx, runtime.currentConfig.value);
  let closeOverlay: (() => void) | undefined;
  const settingsList = new SettingsList(
    items,
    10,
    getSettingsListTheme(),
    (id, newValue) => {
      updateSetting(ctx, runtime, items, id, newValue);
    },
    () => {
      closeOverlay?.();
    },
    { enableSearch: false },
  );
  await ctx.ui.custom(
    (_tui, _theme, _keybindings, done) => {
      closeOverlay = () => {
        done(null);
      };
      return new SettingsOverlay("pruner settings", settingsList);
    },
    { overlay: true, overlayOptions: { width: 60 } },
  );
}

function buildSettingItems(
  ctx: ExtensionCommandContext,
  config: ContextPruneConfig,
): SettingItem[] {
  return [
    booleanItem("enabled", "Enabled", config.enabled, "Enable or disable context pruning"),
    booleanItem(
      "showPruneStatusLine",
      "Prune status line",
      config.showPruneStatusLine,
      "Show footer status",
    ),
    selectItem(
      "pruneOn",
      "Prune trigger",
      PRUNE_ON_MODES.map((mode) => mode.value),
      config.pruneOn,
    ),
    modelItem(ctx, config.summarizerModels[0] ?? "default"),
    selectItem(
      "summarizerThinking",
      "Summarizer thinking",
      SUMMARIZER_THINKING_LEVELS.map((level) => level.value),
      config.summarizerThinking,
    ),
    booleanItem(
      "remindUnprunedCount",
      "Remind unpruned count",
      config.remindUnprunedCount,
      "Agentic-auto reminder",
    ),
    selectItem(
      "batchingMode",
      "Batching mode",
      BATCHING_MODES.map((mode) => mode.value),
      config.batchingMode,
    ),
  ];
}

function booleanItem(id: string, label: string, value: boolean, description: string): SettingItem {
  return { id, label, values: ["true", "false"], currentValue: String(value), description };
}

function selectItem(
  id: string,
  label: string,
  values: string[],
  currentValue: string,
): SettingItem {
  return { id, label, values, currentValue, description: `Current: ${currentValue}` };
}

function modelItem(ctx: ExtensionCommandContext, currentValue: string): SettingItem {
  return {
    id: "summarizerModels",
    label: "Summarizer model",
    values: [currentValue],
    currentValue,
    description: "Model used for summarizing tool outputs — press Enter to browse models",
    submenu: (_value, done) => modelSubmenu(ctx, currentValue, done),
  };
}

function modelSubmenu(
  ctx: ExtensionCommandContext,
  currentValue: string,
  done: (newValue?: string) => void,
): SettingsList {
  const models = ctx.modelRegistry?.getAvailable() ?? [];
  const items: SettingItem[] = [
    {
      id: "default",
      label: "default (active model)",
      values: ["default"],
      currentValue,
      description: "Use active model",
    },
    ...models.map((model) => {
      const id = `${model.provider}/${model.id}`;
      return {
        id,
        label: id,
        values: [id],
        currentValue: currentValue === id ? id : "",
        description: model.name ?? id,
      };
    }),
  ];
  return new SettingsList(
    items,
    15,
    getSettingsListTheme(),
    (_id, newValue) => {
      done(newValue);
    },
    () => {
      done();
    },
    { enableSearch: true },
  );
}

function updateSetting(
  ctx: ExtensionCommandContext,
  runtime: SettingsOverlayRuntime,
  items: SettingItem[],
  id: string,
  newValue: string,
): void {
  const nextConfig = applySetting(runtime.currentConfig.value, id, newValue);
  runtime.currentConfig.value = nextConfig;
  void saveConfig(nextConfig);
  setPruneStatusWidget(ctx, nextConfig, runtime.getStats());
  runtime.syncToolActivation();
  updateItemDescriptions(items, nextConfig);
}

function applySetting(config: ContextPruneConfig, id: string, value: string): ContextPruneConfig {
  if (id === "enabled") return { ...config, enabled: value === "true" };
  if (id === "showPruneStatusLine") return { ...config, showPruneStatusLine: value === "true" };
  if (id === "pruneOn" && isPruneOn(value)) return { ...config, pruneOn: value };
  if (id === "summarizerModels") return { ...config, summarizerModels: [value] };
  if (id === "summarizerThinking" && isThinking(value))
    return { ...config, summarizerThinking: value };
  if (id === "remindUnprunedCount") return { ...config, remindUnprunedCount: value === "true" };
  if (id === "batchingMode" && isBatching(value)) return { ...config, batchingMode: value };
  return config;
}

function updateItemDescriptions(items: SettingItem[], config: ContextPruneConfig): void {
  for (const item of items) {
    item.currentValue = nextItemValue(item.id, config) ?? item.currentValue;
    item.description = `Current: ${item.currentValue}`;
  }
}

function nextItemValue(id: string, config: ContextPruneConfig): string | undefined {
  if (id === "enabled") return String(config.enabled);
  if (id === "showPruneStatusLine") return String(config.showPruneStatusLine);
  if (id === "pruneOn") return config.pruneOn;
  if (id === "summarizerModels") return config.summarizerModels.join(", ");
  if (id === "summarizerThinking") return config.summarizerThinking;
  if (id === "remindUnprunedCount") return String(config.remindUnprunedCount);
  if (id === "batchingMode") return config.batchingMode;
  return undefined;
}

function isPruneOn(value: string): value is ContextPruneConfig["pruneOn"] {
  return PRUNE_ON_MODES.some((mode) => mode.value === value);
}

function isThinking(value: string): value is ContextPruneConfig["summarizerThinking"] {
  return SUMMARIZER_THINKING_LEVELS.some((level) => level.value === value);
}

function isBatching(value: string): value is ContextPruneConfig["batchingMode"] {
  return BATCHING_MODES.some((mode) => mode.value === value);
}
