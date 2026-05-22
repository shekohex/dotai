import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ToolCallIndexer } from "./indexer.js";
import type { ContextPruneConfig, FlushOptions, SummarizerStats } from "./types.js";

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
  updateConfig(patch: Partial<ContextPruneConfig>): void;
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
  updateConfig(patch: Partial<ContextPruneConfig>): void;
  cancel(reason?: string): void;
  flush(ctx: ExtensionContext, options?: FlushOptions): Promise<FlushResult>;
  pendingBatchCount(): number;
  getIndexer(): ToolCallIndexer;
  onPrune(callback: (result: FlushResult) => void): () => void;
}

let runtime: ContextPruneRuntime | null = null;
let footerState: ContextPruneFooterState | undefined;
let lastResult: FlushResult | undefined;

export function setContextPruneRuntime(nextRuntime: ContextPruneRuntime): void {
  runtime = nextRuntime;
}

export function setContextPruneFooterState(nextState: ContextPruneFooterState | undefined): void {
  footerState = nextState;
}

export function getContextPruneFooterState(): ContextPruneFooterState | undefined {
  return footerState;
}

export function setContextPruneLastResult(result: FlushResult): void {
  lastResult = result;
}

export function clearContextPruneLastResult(): void {
  lastResult = undefined;
}

export function getContextPruneLastResult(): FlushResult | undefined {
  return lastResult;
}

export function getContextPruneAPI(_ctx?: ExtensionContext): ContextPruneAPI | null {
  const currentRuntime = runtime;
  if (currentRuntime === null || _ctx === undefined) {
    return null;
  }
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
    flush: (options) => currentRuntime.flush(_ctx, options),
    pendingBatchCount: () => currentRuntime.pendingBatchCount(),
    getIndexer: () => currentRuntime.getIndexer(),
    onPrune: (callback) => currentRuntime.onPrune(callback),
  };
}
