import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  getModesProjectPath,
  loadModesFile,
  saveModesFile,
  type ModesFile,
  type ModeSpec,
} from "../../mode-utils.js";

type ModeRuntimeLike = {
  path: string;
  source: "project" | "global" | "missing";
  data: ModesFile;
  activeMode: string | undefined;
  error?: string;
  lastReportedError?: string;
};

export async function ensureRuntime(
  runtime: ModeRuntimeLike,
  ctx: ExtensionContext,
  deps: {
    hasText: (value: string | undefined) => value is string;
    getModeSpec: (data: ModesFile, modeName: string) => ModeSpec | undefined;
  },
): Promise<void> {
  const previousPath = runtime.path;
  const previousActiveMode = runtime.activeMode;
  const loaded = await loadModesFile(ctx.cwd);
  runtime.source = loaded.source;
  runtime.data = loaded.data;
  runtime.path = loaded.source === "missing" ? getModesProjectPath(ctx.cwd) : loaded.path;
  runtime.error = loaded.error;
  if (!deps.hasText(runtime.error)) {
    runtime.lastReportedError = undefined;
  }

  if (
    previousActiveMode !== undefined &&
    deps.getModeSpec(runtime.data, previousActiveMode) !== undefined
  ) {
    runtime.activeMode = previousActiveMode;
    return;
  }

  if (previousActiveMode === undefined && previousPath === runtime.path) {
    runtime.activeMode = undefined;
    return;
  }

  if (
    runtime.data.currentMode !== undefined &&
    deps.getModeSpec(runtime.data, runtime.data.currentMode) !== undefined
  ) {
    runtime.activeMode = runtime.data.currentMode;
    return;
  }

  runtime.activeMode = undefined;
}

export function syncErrorUI(
  runtime: ModeRuntimeLike,
  ctx: ExtensionContext,
  modeErrorWidgetKey: string,
  hasText: (value: string | undefined) => value is string,
): void {
  if (!ctx.hasUI) return;

  if (!hasText(runtime.error)) {
    ctx.ui.setWidget(modeErrorWidgetKey, undefined);
    return;
  }

  ctx.ui.setWidget(modeErrorWidgetKey, [`Modes config error: ${runtime.path}`, runtime.error]);
}

export function notifyConfigError(
  runtime: ModeRuntimeLike,
  ctx: ExtensionContext,
  hasText: (value: string | undefined) => value is string,
): void {
  if (!ctx.hasUI || !hasText(runtime.error)) return;
  const signature = `${runtime.path}:${runtime.error}`;
  if (runtime.lastReportedError === signature) {
    return;
  }

  runtime.lastReportedError = signature;
  ctx.ui.notify(`Modes config error in ${runtime.path}: ${runtime.error}`, "error");
}

export async function saveRuntime(runtime: ModeRuntimeLike): Promise<void> {
  await saveModesFile(runtime.path, runtime.data);
}

export async function ensureModesReady(
  runtime: ModeRuntimeLike,
  ctx: ExtensionContext,
  deps: {
    ensureRuntime: () => Promise<void>;
    syncErrorUI: () => void;
    notifyConfigError: () => void;
    hasText: (value: string | undefined) => value is string;
  },
): Promise<boolean> {
  await deps.ensureRuntime();
  deps.syncErrorUI();
  if (!deps.hasText(runtime.error)) {
    return true;
  }

  deps.notifyConfigError();
  return false;
}
