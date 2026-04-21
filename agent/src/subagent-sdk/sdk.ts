import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { SubagentRuntimeEventBus } from "./events.js";
import type { MuxAdapter } from "./mux.js";
import type { LaunchCommandBuilder } from "./launch.js";
import { SubagentRuntime } from "./runtime.js";
import { SDKSubagentHandle } from "./sdk-handle.js";
import { createSpawnFunction } from "./sdk-spawn.js";
import type { SubagentRuntimeHooks } from "./runtime-hooks.js";
import type { RuntimeSubagent } from "./types.js";
import type { SubagentHandle, SubagentSDK } from "./sdk-types.js";

export type {
  StartSubagentSpawnOutcomeJsonSchema,
  StartSubagentSpawnOutcomeText,
  StartSubagentSpawnStructuredValue,
  StartSubagentSpawnValue,
  SubagentHandle,
  SubagentSDK,
  SubagentSDKEvent,
} from "./sdk-types.js";

const SDK_EVENT_POLL_INTERVAL_MS = 500;

type CreateSubagentSDKOptions = {
  adapter: MuxAdapter;
  buildLaunchCommand: LaunchCommandBuilder;
  hooks?: SubagentRuntimeHooks;
};

function getStateOrThrow(runtime: SubagentRuntime, sessionId: string): RuntimeSubagent {
  const state = runtime.listStates().find((candidate) => candidate.sessionId === sessionId);
  if (!state) {
    throw new Error(`Unknown subagent sessionId: ${sessionId}`);
  }
  return state;
}

type SubagentSdkObjectInput = {
  runtime: SubagentRuntime;
  adapter: MuxAdapter;
  eventBus: SubagentRuntimeEventBus;
  timer: ReturnType<typeof setInterval>;
  emitChangedStates: () => void;
  toHandle: (sessionId: string) => SubagentHandle;
  spawn: SubagentSDK["spawn"];
};

function createSubagentSdkObject(input: SubagentSdkObjectInput): SubagentSDK {
  return {
    async restore(ctx) {
      await input.runtime.restore(ctx);
      input.emitChangedStates();
      return input.runtime.listStates().map((state) => input.toHandle(state.sessionId));
    },
    spawn: input.spawn,
    async resume(params, ctx, onUpdate) {
      const resumed = await input.runtime.resume(params, ctx, onUpdate);
      input.emitChangedStates();
      return { handle: input.toHandle(resumed.state.sessionId), prompt: resumed.prompt };
    },
    async message(params, ctx, onUpdate) {
      const result = await input.runtime.message(params, ctx, onUpdate);
      input.emitChangedStates();
      return { handle: input.toHandle(result.state.sessionId), result };
    },
    async cancel(params) {
      const cancelled = await input.runtime.cancel(params);
      input.emitChangedStates();
      return cancelled;
    },
    get(sessionId) {
      return input.runtime.listStates().some((state) => state.sessionId === sessionId)
        ? input.toHandle(sessionId)
        : undefined;
    },
    list() {
      return input.runtime.listStates();
    },
    captureOutput({ sessionId, lines }) {
      const state = getStateOrThrow(input.runtime, sessionId);
      return input.adapter.capturePane(state.paneId, lines);
    },
    onEvent(listener) {
      return input.eventBus.subscribe(listener);
    },
    dispose() {
      clearInterval(input.timer);
      input.runtime.dispose();
    },
  };
}

export function createSubagentSDK(
  pi: ExtensionAPI,
  options: CreateSubagentSDKOptions,
): SubagentSDK {
  const runtime = new SubagentRuntime(
    pi,
    options.adapter,
    options.buildLaunchCommand,
    options.hooks,
  );
  const eventBus = new SubagentRuntimeEventBus();
  const emitChangedStates = (): void => {
    eventBus.emitChangedStates(runtime.listStates());
  };
  const timer = setInterval(() => {
    emitChangedStates();
  }, SDK_EVENT_POLL_INTERVAL_MS);
  timer.unref?.();

  let sdkRef: SubagentSDK;
  const toHandle = (sessionId: string): SubagentHandle => new SDKSubagentHandle(sdkRef, sessionId);
  const spawn = createSpawnFunction({ runtime, emitChangedStates, toHandle });
  const sdk = createSubagentSdkObject({
    runtime,
    adapter: options.adapter,
    eventBus,
    timer,
    emitChangedStates,
    toHandle,
    spawn,
  });
  sdkRef = sdk;
  return sdk;
}
