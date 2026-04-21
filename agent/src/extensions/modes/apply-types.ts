import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ModeSpec, ModesFile } from "../../mode-utils.js";
import type { ModeChangeReason, ModeChangeSource } from "./events.js";

export type ModeRuntimeLike = {
  data: ModesFile;
  activeMode: string | undefined;
  applying: boolean;
  needsResyncAfterApply: boolean;
  error?: string;
};

export type ModeApplyDeps = {
  runtime: ModeRuntimeLike;
  ensureRuntime: (ctx: ExtensionContext) => Promise<void>;
  syncErrorUI: (ctx: ExtensionContext) => void;
  ensureModesReady: (ctx: ExtensionContext) => Promise<boolean>;
  saveRuntime: (ctx: ExtensionContext) => Promise<void>;
  getModeSpec: (data: ModesFile, modeName: string) => ModeSpec | undefined;
  inferActiveMode: (
    data: ModesFile,
    activeMode: string | undefined,
    selection: { provider?: string; modelId?: string; thinkingLevel: string },
  ) => string | undefined;
  currentSelection: (
    ctx: ExtensionContext,
    pi: ExtensionAPI,
  ) => { provider?: string; modelId?: string; thinkingLevel: string };
  selectionSatisfiesMode: (
    spec: ModeSpec,
    selection: { provider?: string; modelId?: string; thinkingLevel: string },
  ) => boolean;
  hasText: (value: string | undefined) => value is string;
  hasModelSelection: (spec: ModeSpec) => spec is ModeSpec & { provider: string; modelId: string };
  syncModeTools: (pi: ExtensionAPI, ctx: ExtensionContext, spec: ModeSpec | undefined) => void;
  setStatus: (ctx: ExtensionContext, modeName: string | undefined) => void;
  emitModeChanged: (
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    payload: {
      mode: string | undefined;
      previousMode: string | undefined;
      spec: ModeSpec | undefined;
      reason: ModeChangeReason;
      source: ModeChangeSource;
      cwd: string;
    },
  ) => void;
  appendModeState: (pi: ExtensionAPI, activeMode: string | undefined) => void;
  notifyModeSwitch: (
    ctx: ExtensionContext,
    modeName: string | undefined,
    spec: ModeSpec | undefined,
  ) => void;
};
