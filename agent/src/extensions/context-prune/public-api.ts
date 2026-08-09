import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ToolCallIndexer } from "./indexer.js";
import type {
  ContextPruneConfig,
  ContextPruneConfigPatch,
  FlushOptions,
  SummarizerStats,
} from "./types.js";

export type FlushResult =
  | {
      ok: true;
      reason: "flushed" | "skipped-oversized" | "skipped-undersized";
      batchCount: number;
      toolCallCount: number;
      rawCharCount: number;
      summaryCharCount: number;
    }
  | {
      ok: false;
      reason: string;
      error?: string;
    };

export interface ContextPruneAPI {
  readonly enabled: boolean;
  readonly config: ContextPruneConfig;
  updateConfig(patch: ContextPruneConfigPatch): void;
  cancel(reason?: string): void;
  flush(options?: FlushOptions): Promise<FlushResult>;
  pendingBatchCount(): number;
  getIndexer(): ToolCallIndexer;
  onPrune(callback: (result: FlushResult) => void): () => void;
}

export interface ContextPruneFooterState {
  config: ContextPruneConfig;
  stats?: SummarizerStats;
  overrideText?: string;
  pendingBatchCount: number;
}

interface ContextPruneRuntime {
  getConfig(): ContextPruneConfig;
  updateConfig(patch: ContextPruneConfigPatch): void;
  cancel(reason?: string): void;
  flush(ctx: ExtensionContext, options?: FlushOptions): Promise<FlushResult>;
  pendingBatchCount(): number;
  getIndexer(): ToolCallIndexer;
  onPrune(callback: (result: FlushResult) => void): () => void;
}

const runtimes = new WeakMap<object, ContextPruneRuntime>();
const footerStates = new WeakMap<object, ContextPruneFooterState>();
const lastResults = new WeakMap<object, FlushResult>();

export function setContextPruneRuntime(
  ctx: ExtensionContext,
  nextRuntime: ContextPruneRuntime,
): void {
  runtimes.set(ctx.sessionManager, nextRuntime);
}

export function clearContextPruneRuntime(ctx: ExtensionContext): void {
  runtimes.delete(ctx.sessionManager);
  footerStates.delete(ctx.sessionManager);
  lastResults.delete(ctx.sessionManager);
}

export function setContextPruneFooterState(
  ctx: ExtensionContext,
  nextState: ContextPruneFooterState | undefined,
): void {
  if (nextState === undefined) footerStates.delete(ctx.sessionManager);
  else footerStates.set(ctx.sessionManager, nextState);
}

export function getContextPruneFooterState(
  ctx: ExtensionContext,
): ContextPruneFooterState | undefined {
  return footerStates.get(ctx.sessionManager);
}

export function setContextPruneLastResult(ctx: ExtensionContext, result: FlushResult): void {
  lastResults.set(ctx.sessionManager, result);
}

export function clearContextPruneLastResult(ctx: ExtensionContext): void {
  lastResults.delete(ctx.sessionManager);
}

export function getContextPruneLastResult(ctx: ExtensionContext): FlushResult | undefined {
  return lastResults.get(ctx.sessionManager);
}

export function getContextPruneAPI(ctx?: ExtensionContext): ContextPruneAPI | null {
  if (ctx === undefined) {
    return null;
  }
  const currentRuntime = runtimes.get(ctx.sessionManager);
  if (currentRuntime === undefined) return null;
  return {
    get enabled() {
      return currentRuntime.getConfig().enabled;
    },
    get config() {
      return currentRuntime.getConfig();
    },
    updateConfig: (patch) => {
      currentRuntime.updateConfig(patch);
    },
    cancel: (reason) => {
      currentRuntime.cancel(reason);
    },
    flush: (options) => currentRuntime.flush(ctx, options),
    pendingBatchCount: () => currentRuntime.pendingBatchCount(),
    getIndexer: () => currentRuntime.getIndexer(),
    onPrune: (callback) => currentRuntime.onPrune(callback),
  };
}
