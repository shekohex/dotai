import type { CompactionResult, ExtensionHandler } from "@earendil-works/pi-coding-agent";

declare module "@earendil-works/pi-coding-agent" {
  /**
   * Session queue snapshot emitted by local runtimes that bridge AgentSession queue events into
   * ExtensionAPI. Upstream extensions should not assume every Pi runtime emits this event.
   */
  interface QueueUpdateExtensionEvent {
    type: "queue_update";
    steering: readonly string[];
    followUp: readonly string[];
  }

  /**
   * AgentSession-level compaction start event when bridged into ExtensionAPI by local runtime code.
   * Upstream Pi 0.75.x exposes reliable extension compaction hooks as session_before_compact and
   * session_compact; use those for core extension behavior that must run in all runtimes.
   */
  interface CompactionStartExtensionEvent {
    type: "compaction_start";
    reason: "manual" | "threshold" | "overflow";
  }

  /**
   * AgentSession-level compaction completion event when bridged into ExtensionAPI by local runtime
   * code. Upstream Pi 0.75.x does not emit this through ExtensionRunner, so extension logic that
   * must resume after successful compaction should use session_compact unless the runtime
   * explicitly forwards this event.
   */
  interface CompactionEndExtensionEvent {
    type: "compaction_end";
    reason: "manual" | "threshold" | "overflow";
    result: CompactionResult | undefined;
    aborted: boolean;
    willRetry: boolean;
    errorMessage?: string;
  }

  /** Retry lifecycle event emitted by local runtimes that forward AgentSession auto-retry events. */
  interface AutoRetryStartExtensionEvent {
    type: "auto_retry_start";
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    errorMessage: string;
  }

  /** Retry lifecycle event emitted by local runtimes that forward AgentSession auto-retry events. */
  interface AutoRetryEndExtensionEvent {
    type: "auto_retry_end";
    success: boolean;
    attempt: number;
    finalError?: string;
  }

  interface ExtensionAPI {
    /** Subscribe to bridged queue snapshots when supported by the active runtime. */
    on(event: "queue_update", handler: ExtensionHandler<QueueUpdateExtensionEvent>): void;
    /** Subscribe to bridged AgentSession compaction start events when supported by the runtime. */
    on(event: "compaction_start", handler: ExtensionHandler<CompactionStartExtensionEvent>): void;
    /** Subscribe to bridged AgentSession compaction end events when supported by the runtime. */
    on(event: "compaction_end", handler: ExtensionHandler<CompactionEndExtensionEvent>): void;
    /** Subscribe to bridged AgentSession auto-retry start events when supported by the runtime. */
    on(event: "auto_retry_start", handler: ExtensionHandler<AutoRetryStartExtensionEvent>): void;
    /** Subscribe to bridged AgentSession auto-retry end events when supported by the runtime. */
    on(event: "auto_retry_end", handler: ExtensionHandler<AutoRetryEndExtensionEvent>): void;
  }
}
