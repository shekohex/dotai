import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import type { AutocompleteItem } from "@mariozechner/pi-tui";

import { getModesProjectPath, loadModesFile, saveModesFile, type ModeSpec, type ModesFile } from "../mode-utils.js";

export const MODE_STATE_ENTRY = "mode-state";
const MODE_STATUS_KEY = "mode";
const CUSTOM_MODE_LABEL = "custom";

type ModeRuntime = {
  path: string;
  source: "project" | "global" | "missing";
  data: ModesFile;
  activeMode: string | undefined;
  applying: boolean;
  error?: string;
  lastReportedError?: string;
};

export type ModeChangedEvent = {
  mode: string | undefined;
  previousMode: string | undefined;
  spec: ModeSpec | undefined;
  reason: "apply" | "store" | "restore" | "sync" | "cycle";
  source: "command" | "shortcut" | "session_start" | "model_select" | "before_agent_start";
  cwd: string;
};

const runtime: ModeRuntime = {
  path: "",
  source: "missing",
  data: { version: 1, currentMode: undefined, modes: {} },
  activeMode: undefined,
  applying: false,
  error: undefined,
  lastReportedError: undefined,
};

const MODE_ERROR_WIDGET_KEY = "mode-config-error";

function orderedModeNames(data: ModesFile): string[] {
  return Object.keys(data.modes).sort((left, right) => left.localeCompare(right));
}

function getModeSpec(data: ModesFile, modeName: string): ModeSpec | undefined {
  return data.modes[modeName];
}

function describeModeSpec(spec: ModeSpec | undefined): string | undefined {
  if (!spec) return undefined;

  const parts: string[] = [];
  if (spec.provider && spec.modelId) {
    parts.push(`${spec.provider}/${spec.modelId}`);
  }
  if (spec.thinkingLevel) {
    parts.push(`thinking:${spec.thinkingLevel}`);
  }

  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function describeModeAutocomplete(modeName: string, spec: ModeSpec | undefined): string | undefined {
  const parts: string[] = [];
  if (runtime.activeMode === modeName) {
    parts.push("active");
  }

  const details = describeModeSpec(spec);
  if (details) {
    parts.push(details);
  }

  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function filterAutocompleteItems(items: AutocompleteItem[], query: string): AutocompleteItem[] | null {
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = normalizedQuery.length === 0
    ? items
    : items.filter((item) => {
      const haystack = [item.value, item.label, item.description]
        .filter((value): value is string => Boolean(value))
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });

  return filtered.length > 0 ? filtered : null;
}

function getModeSelectionItems(): AutocompleteItem[] {
  return orderedModeNames(runtime.data).map((modeName) => ({
    value: modeName,
    label: modeName,
    description: describeModeAutocomplete(modeName, getModeSpec(runtime.data, modeName)),
  }));
}

function getModeRootCompletions(query: string): AutocompleteItem[] | null {
  return filterAutocompleteItems([
    ...getModeSelectionItems(),
    {
      value: "store ",
      label: "store",
      description: "Save current selection as a mode",
    },
    {
      value: "reload",
      label: "reload",
      description: "Reload modes from config",
    },
  ], query);
}

function getModeStoreCompletions(query: string): AutocompleteItem[] | null {
  const items = orderedModeNames(runtime.data).map((modeName) => ({
    value: `store ${modeName}`,
    label: modeName,
    description: ["Overwrite existing mode", describeModeAutocomplete(modeName, getModeSpec(runtime.data, modeName))]
      .filter((value): value is string => Boolean(value))
      .join(" · "),
  }));

  return filterAutocompleteItems(items, query);
}

function getModeArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  const normalizedPrefix = argumentPrefix.replace(/^\s+/, "");
  if (!normalizedPrefix) {
    return getModeRootCompletions("");
  }

  const tokens = normalizedPrefix.split(/\s+/).filter(Boolean);
  const endsWithSpace = /\s$/.test(normalizedPrefix);
  const command = tokens[0];
  if (!command) {
    return getModeRootCompletions("");
  }

  if (command === "store") {
    if (tokens.length === 1 && !endsWithSpace) {
      return getModeRootCompletions(command);
    }

    if (tokens.length > 2) {
      return null;
    }

    return getModeStoreCompletions(tokens[1] ?? "");
  }

  if (command === "reload") {
    return tokens.length === 1 && !endsWithSpace ? getModeRootCompletions(command) : null;
  }

  return tokens.length === 1 && !endsWithSpace ? getModeRootCompletions(command) : null;
}

function notifyModeSwitch(ctx: ExtensionContext, modeName: string | undefined, spec: ModeSpec | undefined): void {
  if (!ctx.hasUI) return;

  const label = modeName ?? CUSTOM_MODE_LABEL;
  const description = describeModeSpec(spec);
  ctx.ui.notify(
    description ? `Switched mode to "${label}" (${description})` : `Switched mode to "${label}"`,
    "info",
  );
}

function currentSelection(ctx: ExtensionContext, pi: ExtensionAPI): { provider?: string; modelId?: string; thinkingLevel: string } {
  return {
    provider: ctx.model?.provider,
    modelId: ctx.model?.id,
    thinkingLevel: pi.getThinkingLevel(),
  };
}

function matchesMode(spec: ModeSpec, selection: { provider?: string; modelId?: string; thinkingLevel: string }): boolean {
  if (spec.provider && spec.modelId) {
    if (spec.provider !== selection.provider || spec.modelId !== selection.modelId) {
      return false;
    }
  }

  if (spec.thinkingLevel && spec.thinkingLevel !== selection.thinkingLevel) {
    return false;
  }

  return Boolean(spec.provider && spec.modelId) || Boolean(spec.thinkingLevel);
}

function inferActiveMode(pi: ExtensionAPI, ctx: ExtensionContext): string | undefined {
  const selection = currentSelection(ctx, pi);
  for (const modeName of orderedModeNames(runtime.data)) {
    const spec = getModeSpec(runtime.data, modeName);
    if (spec && matchesMode(spec, selection)) {
      return modeName;
    }
  }
  return undefined;
}

function setStatus(ctx: ExtensionContext, modeName: string | undefined): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(MODE_STATUS_KEY, ctx.ui.theme.fg(modeName ? "accent" : "warning", `mode:${modeName ?? CUSTOM_MODE_LABEL}`));
}

function emitModeChanged(pi: ExtensionAPI, _ctx: ExtensionContext, payload: ModeChangedEvent): void {
  pi.events.emit("modes:changed", payload);
}

function appendModeState(pi: ExtensionAPI, activeMode: string | undefined): void {
  if (!activeMode) return;
  pi.appendEntry(MODE_STATE_ENTRY, { activeMode });
}

async function ensureRuntime(ctx: ExtensionContext): Promise<void> {
  const loaded = await loadModesFile(ctx.cwd);
  runtime.source = loaded.source;
  runtime.data = loaded.data;
  runtime.path = loaded.source === "missing" ? getModesProjectPath(ctx.cwd) : loaded.path;
  runtime.error = loaded.error;
  if (!runtime.error) {
    runtime.lastReportedError = undefined;
  }

  if (runtime.data.currentMode && runtime.data.modes[runtime.data.currentMode]) {
    runtime.activeMode = runtime.data.currentMode;
    return;
  }

  runtime.activeMode = undefined;
}

function syncErrorUI(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  if (!runtime.error) {
    ctx.ui.setWidget(MODE_ERROR_WIDGET_KEY, undefined);
    return;
  }

  ctx.ui.setWidget(MODE_ERROR_WIDGET_KEY, [
    `Modes config error: ${runtime.path}`,
    runtime.error,
  ]);
}

function notifyConfigError(ctx: ExtensionContext): void {
  if (!ctx.hasUI || !runtime.error) return;
  const signature = `${runtime.path}:${runtime.error}`;
  if (runtime.lastReportedError === signature) {
    return;
  }

  runtime.lastReportedError = signature;
  ctx.ui.notify(`Modes config error in ${runtime.path}: ${runtime.error}`, "error");
}

async function saveRuntime(_ctx: ExtensionContext): Promise<void> {
  await saveModesFile(runtime.path, runtime.data);
}

async function syncFromSelection(pi: ExtensionAPI, ctx: ExtensionContext, source: ModeChangedEvent["source"]): Promise<void> {
  await ensureRuntime(ctx);
  syncErrorUI(ctx);
  if (runtime.error) {
    const previousMode = runtime.activeMode;
    runtime.activeMode = undefined;
    setStatus(ctx, undefined);
    if (previousMode !== undefined) {
      emitModeChanged(pi, ctx, {
        mode: undefined,
        previousMode,
        spec: undefined,
        reason: "sync",
        source,
        cwd: ctx.cwd,
      });
    }
    return;
  }

  const previousMode = runtime.activeMode;
  const nextMode = inferActiveMode(pi, ctx);
  runtime.activeMode = nextMode;
  setStatus(ctx, nextMode);

  if (previousMode !== nextMode) {
    if (source === "model_select") {
      notifyModeSwitch(ctx, nextMode, nextMode ? getModeSpec(runtime.data, nextMode) : undefined);
    }

    emitModeChanged(pi, ctx, {
      mode: nextMode,
      previousMode,
      spec: nextMode ? getModeSpec(runtime.data, nextMode) : undefined,
      reason: "sync",
      source,
      cwd: ctx.cwd,
    });
  }
}

async function applyMode(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  modeName: string,
  source: ModeChangedEvent["source"],
  reason: ModeChangedEvent["reason"] = "apply",
  options: { persist?: boolean } = {},
): Promise<void> {
  await ensureRuntime(ctx);
  syncErrorUI(ctx);
  if (runtime.error) {
    notifyConfigError(ctx);
    return;
  }

  const spec = getModeSpec(runtime.data, modeName);
  if (!spec) {
    ctx.ui.notify(`Unknown mode "${modeName}"`, "warning");
    return;
  }

  runtime.applying = true;
  const previousMode = runtime.activeMode;
  try {
    if (spec.provider && spec.modelId) {
      const model = ctx.modelRegistry.find(spec.provider, spec.modelId);
      if (!model) {
        ctx.ui.notify(`Mode "${modeName}" references missing model ${spec.provider}/${spec.modelId}`, "warning");
        return;
      }

      const modelApplied = await pi.setModel(model);
      if (!modelApplied) {
        ctx.ui.notify(`No API key available for ${spec.provider}/${spec.modelId}`, "warning");
        return;
      }
    }

    if (spec.thinkingLevel) {
      pi.setThinkingLevel(spec.thinkingLevel);
    }

    runtime.activeMode = modeName;
    runtime.data.currentMode = modeName;
    if (options.persist !== false) {
      await saveRuntime(ctx);
    }
    setStatus(ctx, modeName);
    appendModeState(pi, modeName);
    emitModeChanged(pi, ctx, {
      mode: modeName,
      previousMode,
      spec,
      reason,
      source,
      cwd: ctx.cwd,
    });
    if (previousMode !== modeName && (source === "command" || source === "shortcut")) {
      notifyModeSwitch(ctx, modeName, spec);
    }
  } finally {
    runtime.applying = false;
  }
}

async function storeMode(pi: ExtensionAPI, ctx: ExtensionContext, modeName: string): Promise<void> {
  await ensureRuntime(ctx);
  syncErrorUI(ctx);
  const name = modeName.trim();
  if (!name) {
    ctx.ui.notify("Mode name cannot be empty", "warning");
    return;
  }

  const selection = currentSelection(ctx, pi);
  const existing = runtime.data.modes[name] ?? {};
  runtime.data.modes[name] = {
    ...existing,
    provider: selection.provider,
    modelId: selection.modelId,
    thinkingLevel: selection.thinkingLevel as ModeSpec["thinkingLevel"],
  };
  runtime.data.currentMode = name;
  runtime.activeMode = name;
  await saveRuntime(ctx);
  setStatus(ctx, name);
  appendModeState(pi, name);
  emitModeChanged(pi, ctx, {
    mode: name,
    previousMode: undefined,
    spec: runtime.data.modes[name],
    reason: "store",
    source: "command",
    cwd: ctx.cwd,
  });
  const description = describeModeSpec(runtime.data.modes[name]);
  ctx.ui.notify(
    description ? `Stored and switched to mode "${name}" (${description})` : `Stored and switched to mode "${name}"`,
    "info",
  );
}

async function reloadModes(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  runtime.path = "";
  await ensureRuntime(ctx);
  syncErrorUI(ctx);
  if (runtime.error) {
    notifyConfigError(ctx);
    return;
  }

  if (runtime.data.currentMode && runtime.data.modes[runtime.data.currentMode]) {
    await applyMode(pi, ctx, runtime.data.currentMode, "command", "restore", { persist: false });
    return;
  }

  await syncFromSelection(pi, ctx, "command");
  ctx.ui.notify("Modes reloaded", "info");
}

async function promptForModeName(ctx: ExtensionContext, title: string): Promise<string | undefined> {
  const value = await ctx.ui.input(title, "mode name");
  return value?.trim() || undefined;
}

async function showModePicker(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  await ensureRuntime(ctx);
  syncErrorUI(ctx);
  if (runtime.error) {
    notifyConfigError(ctx);
    return;
  }

  const names = orderedModeNames(runtime.data);
  const options = [...names, "store current setup", "reload modes"];
  const choice = await ctx.ui.select(`Mode (${runtime.activeMode ?? CUSTOM_MODE_LABEL})`, options);
  if (!choice) return;

  if (choice === "store current setup") {
    const name = await promptForModeName(ctx, "Store current setup as mode");
    if (!name) return;
    await storeMode(pi, ctx, name);
    return;
  }

  if (choice === "reload modes") {
    await reloadModes(pi, ctx);
    return;
  }

  await applyMode(pi, ctx, choice, "command");
}

async function cycleMode(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  await ensureRuntime(ctx);
  syncErrorUI(ctx);
  if (runtime.error) {
    notifyConfigError(ctx);
    return;
  }

  const names = orderedModeNames(runtime.data);
  if (names.length === 0) {
    ctx.ui.notify("No modes defined. Use /mode store <name> to create one.", "warning");
    return;
  }

  const currentIndex = runtime.activeMode ? names.indexOf(runtime.activeMode) : -1;
  const nextIndex = (currentIndex + 1) % names.length;
  await applyMode(pi, ctx, names[nextIndex]!, "shortcut", "cycle");
}

async function restoreMode(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  await ensureRuntime(ctx);
  syncErrorUI(ctx);
  if (runtime.error) {
    notifyConfigError(ctx);
    setStatus(ctx, undefined);
    emitModeChanged(pi, ctx, {
      mode: undefined,
      previousMode: undefined,
      spec: undefined,
      reason: "restore",
      source: "session_start",
      cwd: ctx.cwd,
    });
    return;
  }

  const entries = ctx.sessionManager.getEntries();
  const modeEntries = entries.filter((entry) => entry.type === "custom" && entry.customType === MODE_STATE_ENTRY);
  const lastEntry = modeEntries[modeEntries.length - 1] as { data?: { activeMode?: string } } | undefined;
  const sessionMode = lastEntry?.data?.activeMode;
  const hasExplicitSessionSelection = entries.some(
    (entry) => entry.type === "model_change" || entry.type === "thinking_level_change",
  );

  if (sessionMode && runtime.data.modes[sessionMode]) {
    await applyMode(pi, ctx, sessionMode, "session_start", "restore", { persist: false });
    return;
  }

  if (hasExplicitSessionSelection) {
    await syncFromSelection(pi, ctx, "session_start");
    emitModeChanged(pi, ctx, {
      mode: runtime.activeMode,
      previousMode: undefined,
      spec: runtime.activeMode ? getModeSpec(runtime.data, runtime.activeMode) : undefined,
      reason: "restore",
      source: "session_start",
      cwd: ctx.cwd,
    });
    return;
  }

  if (runtime.data.currentMode && runtime.data.modes[runtime.data.currentMode]) {
    await applyMode(pi, ctx, runtime.data.currentMode, "session_start", "restore", { persist: false });
    return;
  }

  await syncFromSelection(pi, ctx, "session_start");
  emitModeChanged(pi, ctx, {
    mode: runtime.activeMode,
    previousMode: undefined,
    spec: runtime.activeMode ? getModeSpec(runtime.data, runtime.activeMode) : undefined,
    reason: "restore",
    source: "session_start",
    cwd: ctx.cwd,
  });
}

export default function modesExtension(pi: ExtensionAPI): void {
  pi.registerCommand("mode", {
    description: "Select and store prompt modes: /mode, /mode <name>, /mode store <name>, /mode reload",
    getArgumentCompletions: (prefix) => getModeArgumentCompletions(prefix),
    handler: async (args, ctx) => {
      const tokens = args.split(/\s+/).map((value) => value.trim()).filter(Boolean);
      if (tokens.length === 0) {
        await showModePicker(pi, ctx);
        return;
      }

      if (tokens[0] === "store") {
        const name = tokens[1] ?? (await promptForModeName(ctx, "Store current setup as mode"));
        if (!name) return;
        await storeMode(pi, ctx, name);
        return;
      }

      if (tokens[0] === "reload") {
        await reloadModes(pi, ctx);
        return;
      }

      await applyMode(pi, ctx, tokens[0]!, "command");
    },
  });

  pi.registerShortcut(Key.ctrlShift("s"), {
    description: "Select prompt mode",
    handler: async (ctx) => {
      await showModePicker(pi, ctx);
    },
  });

  pi.registerShortcut(Key.ctrlShift("m"), {
    description: "Cycle prompt mode",
    handler: async (ctx) => {
      await cycleMode(pi, ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    runtime.path = "";
    await restoreMode(pi, ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    if (runtime.applying) return;
    await syncFromSelection(pi, ctx, "model_select");
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (runtime.applying) return;
    await syncFromSelection(pi, ctx, "before_agent_start");
  });

  pi.on("turn_start", async (_event, ctx) => {
    appendModeState(pi, runtime.activeMode);
    setStatus(ctx, runtime.activeMode);
  });
}
