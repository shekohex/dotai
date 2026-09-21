import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type {
  Api,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { streamSimple as compatStreamSimple } from "@earendil-works/pi-ai/compat";

export type WorkerStreamSimple = (
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/**
 * Duck-typed subset of Pi's extension ModelRegistry accepted by background workers.
 *
 * `streamSimple` is the host-composed path. Until that lands on the facade,
 * `getRegisteredProviderConfig` exposes each `registerProvider` `streamSimple` handler by provider
 * id. Use only the model's exact provider and require matching API metadata as a consistency
 * check.
 */
export type StreamableModelRegistry = Pick<
  ModelRegistry,
  "streamSimple" | "getRegisteredProviderConfig"
>;

/**
 * Resolve the stream function background workers must pass to `agentLoop`.
 *
 * Direct `@earendil-works/pi-ai/compat` `streamSimple` only knows built-in API ids. Custom
 * providers (`cursor-sdk`, `cliproxyapi-*`, commandcode, …) live on Pi's composed runtime. Using
 * compat after a successful foreground turn is what crashes Pi with `No API provider registered for
 * api: …` (#30).
 *
 * @param {Model<Api>} model The worker's resolved request model.
 * @param {StreamableModelRegistry | null} [modelRegistry] Host registry exposing composed provider
 *   streams, when available.
 * @param {WorkerStreamSimple} [override] Explicit stream function that wins over the registry.
 * @returns {WorkerStreamSimple} The stream function to hand to the agent loop.
 */
export function resolveWorkerStreamSimple(
  model: Model<Api>,
  modelRegistry?: StreamableModelRegistry | null,
  override?: WorkerStreamSimple,
): WorkerStreamSimple {
  if (override) return override;

  const registryStream = modelRegistry?.streamSimple;
  if (registryStream !== undefined) {
    return (nextModel, context, options) =>
      registryStream.call(modelRegistry, nextModel, context, options);
  }

  try {
    const config = modelRegistry?.getRegisteredProviderConfig(model.provider);
    const composed = config?.streamSimple;
    if (config?.api === model.api && composed !== undefined) {
      return composed;
    }
  } catch {
    // Incomplete host/test doubles still use the built-in compat dispatcher.
  }

  return compatStreamSimple;
}
