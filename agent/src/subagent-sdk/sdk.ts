import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { SubagentRuntimeEventBus } from "./events.js";
import type { MuxAdapter } from "./mux.js";
import type { LaunchCommandBuilder } from "./launch.js";
import { createSubagentIpcServer, type SubagentIpcServer } from "./ipc.js";
import { SubagentRuntime } from "./runtime.js";
import { SDKSubagentHandle } from "./sdk-handle.js";
import { createSpawnFunction } from "./sdk-spawn.js";
import type { SubagentRuntimeHooks } from "./runtime-hooks.js";
import type { RuntimeSubagent } from "./types.js";
import type { SubagentHandle, SubagentSDK } from "./sdk-types.js";
import type { AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  StartSubagentParams,
  StartSubagentParamsJsonSchema,
  StartSubagentParamsText,
  TSchemaBase,
} from "./types.js";

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
  ipcServer: SubagentIpcServer;
  timer: ReturnType<typeof setInterval>;
  emitChangedStates: () => void;
  toHandle: (sessionId: string) => SubagentHandle;
  start: SubagentSDK["start"];
  spawn: SubagentSDK["spawn"];
};

function createSubagentSdkObject(input: SubagentSdkObjectInput): SubagentSDK {
  return {
    async restore(ctx) {
      await input.runtime.restore(ctx);
      input.emitChangedStates();
      return input.runtime.listStates().map((state) => input.toHandle(state.sessionId));
    },
    start: input.start,
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
    onChildEvent(sessionId, eventType, listener) {
      return input.eventBus.subscribeChildEvent((event, eventSessionId) => {
        if (eventSessionId !== sessionId || event.type !== eventType) {
          return;
        }
        listener(event);
      });
    },
    dispose() {
      clearInterval(input.timer);
      input.ipcServer.dispose();
      input.runtime.dispose();
    },
  };
}

export function createSubagentSDK(
  pi: ExtensionAPI,
  options: CreateSubagentSDKOptions,
): SubagentSDK {
  const ipcServer = createSubagentIpcServer();
  const buildLaunchCommand: LaunchCommandBuilder = (state, childState, prompt, launchOptions) => {
    const ipc = ipcServer.createRoute(state.sessionId);
    return options.buildLaunchCommand(state, { ...childState, ipc }, prompt, launchOptions);
  };
  const runtime = new SubagentRuntime(pi, options.adapter, buildLaunchCommand, options.hooks);
  const eventBus = new SubagentRuntimeEventBus();
  ipcServer.onChildEvent(({ sessionId, event }) => {
    eventBus.emitChildEvent(sessionId, event);
  });
  const emitChangedStates = (): void => {
    eventBus.emitChangedStates(runtime.listStates());
  };
  const timer = setInterval(() => {
    emitChangedStates();
  }, SDK_EVENT_POLL_INTERVAL_MS);
  timer.unref?.();

  let sdkRef: SubagentSDK;
  const toHandle = (sessionId: string): SubagentHandle => new SDKSubagentHandle(sdkRef, sessionId);
  async function start(
    params: StartSubagentParamsText,
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback,
    signal?: AbortSignal,
  ): Promise<ReturnType<SubagentSDK["start"]> extends Promise<infer TValue> ? TValue : never>;
  async function start<TSchemaValue extends TSchemaBase>(
    params: StartSubagentParamsJsonSchema<TSchemaValue>,
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback,
    signal?: AbortSignal,
  ): Promise<ReturnType<SubagentSDK["start"]> extends Promise<infer TValue> ? TValue : never>;
  async function start(
    params: StartSubagentParams,
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback,
    signal?: AbortSignal,
  ) {
    const started = await runtime.spawn(params, ctx, onUpdate, signal);
    emitChangedStates();
    return {
      handle: toHandle(started.state.sessionId),
      prompt: started.prompt,
      state: started.state,
    };
  }
  const spawn = createSpawnFunction({ runtime, emitChangedStates, toHandle });
  const sdk = createSubagentSdkObject({
    runtime,
    adapter: options.adapter,
    eventBus,
    ipcServer,
    timer,
    emitChangedStates,
    toHandle,
    start,
    spawn,
  });
  sdkRef = sdk;
  return sdk;
}
