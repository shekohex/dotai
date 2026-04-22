import type { CompactionResult, ExtensionHandler } from "@mariozechner/pi-coding-agent";

declare module "@mariozechner/pi-coding-agent" {
  interface QueueUpdateExtensionEvent {
    type: "queue_update";
    steering: readonly string[];
    followUp: readonly string[];
  }

  interface CompactionStartExtensionEvent {
    type: "compaction_start";
    reason: "manual" | "threshold" | "overflow";
  }

  interface CompactionEndExtensionEvent {
    type: "compaction_end";
    reason: "manual" | "threshold" | "overflow";
    result: CompactionResult | undefined;
    aborted: boolean;
    willRetry: boolean;
    errorMessage?: string;
  }

  interface AutoRetryStartExtensionEvent {
    type: "auto_retry_start";
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    errorMessage: string;
  }

  interface AutoRetryEndExtensionEvent {
    type: "auto_retry_end";
    success: boolean;
    attempt: number;
    finalError?: string;
  }

  interface ExtensionAPI {
    on(event: "queue_update", handler: ExtensionHandler<QueueUpdateExtensionEvent>): void;
    on(event: "compaction_start", handler: ExtensionHandler<CompactionStartExtensionEvent>): void;
    on(event: "compaction_end", handler: ExtensionHandler<CompactionEndExtensionEvent>): void;
    on(event: "auto_retry_start", handler: ExtensionHandler<AutoRetryStartExtensionEvent>): void;
    on(event: "auto_retry_end", handler: ExtensionHandler<AutoRetryEndExtensionEvent>): void;
  }
}

export type ExtensionEventAugmentationMarker = true;
