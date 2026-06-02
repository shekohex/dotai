import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { SubagentRuntimeEventBus } from "./events.js";
import type { MuxAdapter } from "./mux.js";
import type { LaunchCommandBuilder } from "./launch.js";
import { createSubagentIpcServer } from "./ipc.js";
import { LiteRuntime, type LiteRuntimeOptions } from "./lite-runtime.js";
import { SubagentRuntime } from "./runtime.js";
import { SDKSubagentHandle } from "./sdk-handle.js";
import { createSpawnFunction } from "./sdk-spawn.js";
import type { SubagentRuntimeHooks } from "./runtime-hooks.js";
import type { RuntimeSubagent } from "./types.js";
import type {
  SubagentHandle,
  SubagentSDK,
  SubagentSDKAny,
  SubagentSDKLite,
  SubagentSDKProcess,
} from "./sdk-types.js";
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

type ProcessBackendOptions = {
  kind: "process";
  adapter: MuxAdapter;
  buildLaunchCommand: LaunchCommandBuilder;
  hooks?: SubagentRuntimeHooks;
};

type CreateSubagentSDKProcessOptions =
  | {
      adapter: MuxAdapter;
      buildLaunchCommand: LaunchCommandBuilder;
      hooks?: SubagentRuntimeHooks;
    }
  | {
      backend: ProcessBackendOptions;
    };

type CreateSubagentSDKLiteOptions = {
  backend: LiteRuntimeOptions;
};

type CreateSubagentSDKOptions = CreateSubagentSDKProcessOptions | CreateSubagentSDKLiteOptions;

type SdkRuntimeBackend = {
  restore(ctx: ExtensionContext): Promise<void>;
  spawn(
    params: StartSubagentParams,
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback,
    signal?: AbortSignal,
  ): Promise<{ state: RuntimeSubagent; prompt: string }>;
  resume(
    params: Parameters<SubagentSDK["resume"]>[0],
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback,
  ): Promise<{ state: RuntimeSubagent; prompt: string }>;
  message(
    params: Parameters<SubagentSDK["message"]>[0],
    ctx: ExtensionContext,
    onUpdate?: AgentToolUpdateCallback,
  ): Promise<Awaited<ReturnType<SubagentSDK["message"]>>["result"]>;
  cancel(params: Parameters<SubagentSDK["cancel"]>[0]): Promise<RuntimeSubagent>;
  listStates(): RuntimeSubagent[];
  dispose(): void;
};

function getStateOrThrow(runtime: SdkRuntimeBackend, sessionId: string): RuntimeSubagent {
  const state = runtime.listStates().find((candidate) => candidate.sessionId === sessionId);
  if (!state) {
    throw new Error(`Unknown subagent sessionId: ${sessionId}`);
  }
  return state;
}

type SubagentSdkObjectInput<TBackend extends SubagentSDK["backend"] = SubagentSDK["backend"]> = {
  backend: TBackend;
  runtime: SdkRuntimeBackend;
  emitChangedStates: () => void;
  toHandle: (sessionId: string) => SubagentHandle;
  start: SubagentSDK["start"];
  spawn: SubagentSDK["spawn"];
  captureOutput: SubagentSDK["captureOutput"];
  onEvent: SubagentSDK["onEvent"];
  onChildEvent: SubagentSDK["onChildEvent"];
  dispose: () => void;
};

function createSubagentSdkObject(input: SubagentSdkObjectInput<"process">): SubagentSDKProcess;
function createSubagentSdkObject(input: SubagentSdkObjectInput<"lite">): SubagentSDKLite;
function createSubagentSdkObject(input: SubagentSdkObjectInput): SubagentSDK {
  return {
    backend: input.backend,
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
    captureOutput: input.captureOutput,
    onEvent: input.onEvent,
    onChildEvent: input.onChildEvent,
    dispose: input.dispose,
  };
}

function createLiteSubagentSdkObject(runtime: LiteRuntime): SubagentSDKLite {
  let sdkRef: SubagentSDKLite;
  const toHandle = (sessionId: string): SubagentHandle => new SDKSubagentHandle(sdkRef, sessionId);
  const emitChangedStates = (): void => {
    runtime.emitChangedStates();
  };
  const start = createStartFunction({ runtime, emitChangedStates, toHandle });
  const spawn = createSpawnFunction({ runtime, emitChangedStates, toHandle });
  const sdk = createSubagentSdkObject({
    backend: "lite",
    runtime,
    emitChangedStates,
    toHandle,
    start,
    spawn,
    captureOutput({ sessionId }) {
      return Promise.resolve(runtime.captureOutput(sessionId));
    },
    onEvent(listener) {
      return runtime.onEvent(listener);
    },
    onChildEvent(sessionId, eventType, listener) {
      return runtime.onChildEvent((event, eventSessionId) => {
        if (eventSessionId !== sessionId || event.type !== eventType) {
          return;
        }
        listener(event);
      });
    },
    dispose() {
      runtime.dispose();
    },
  });
  sdkRef = sdk;
  return sdk;
}

type StartFunctionFactoryInput = {
  runtime: SdkRuntimeBackend;
  emitChangedStates: () => void;
  toHandle: (sessionId: string) => SubagentHandle;
};

function createStartFunction(input: StartFunctionFactoryInput): SubagentSDK["start"] {
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
    const started = await input.runtime.spawn(params, ctx, onUpdate, signal);
    input.emitChangedStates();
    return {
      handle: input.toHandle(started.state.sessionId),
      prompt: started.prompt,
      state: started.state,
    };
  }
  return start;
}

function resolveProcessOptions(options: CreateSubagentSDKProcessOptions): ProcessBackendOptions {
  if ("backend" in options) {
    return options.backend;
  }
  return {
    kind: "process",
    adapter: options.adapter,
    buildLaunchCommand: options.buildLaunchCommand,
    hooks: options.hooks,
  };
}

function isLiteOptions(options: CreateSubagentSDKOptions): options is CreateSubagentSDKLiteOptions {
  return "backend" in options && options.backend?.kind === "lite";
}

export function isProcessSDK(sdk: SubagentSDKAny): sdk is SubagentSDKProcess {
  return sdk.backend === "process";
}

export function isLiteSDK(sdk: SubagentSDKAny): sdk is SubagentSDKLite {
  return sdk.backend === "lite";
}

export function createSubagentSDK(
  pi: ExtensionAPI,
  options: CreateSubagentSDKLiteOptions,
): SubagentSDKLite;
export function createSubagentSDK(
  pi: ExtensionAPI,
  options: CreateSubagentSDKProcessOptions,
): SubagentSDKProcess;
export function createSubagentSDK(
  pi: ExtensionAPI,
  options: CreateSubagentSDKOptions,
): SubagentSDKAny {
  if (isLiteOptions(options)) {
    return createLiteSubagentSdkObject(new LiteRuntime(pi, options.backend));
  }
  const processOptions = resolveProcessOptions(options);
  const ipcServer = createSubagentIpcServer();
  const buildLaunchCommand: LaunchCommandBuilder = (state, childState, prompt, launchOptions) => {
    const ipc = ipcServer.createRoute(state.sessionId);
    return processOptions.buildLaunchCommand(state, { ...childState, ipc }, prompt, launchOptions);
  };
  const runtime = new SubagentRuntime(
    pi,
    processOptions.adapter,
    buildLaunchCommand,
    processOptions.hooks,
  );
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
  const start = createStartFunction({ runtime, emitChangedStates, toHandle });
  const spawn = createSpawnFunction({ runtime, emitChangedStates, toHandle });
  const sdk = createSubagentSdkObject({
    backend: "process",
    runtime,
    emitChangedStates,
    toHandle,
    start,
    spawn,
    captureOutput({ sessionId, lines }) {
      const state = getStateOrThrow(runtime, sessionId);
      return processOptions.adapter.capturePane(state.paneId, lines, state.muxBackend);
    },
    onEvent(listener) {
      return eventBus.subscribe(listener);
    },
    onChildEvent(sessionId, eventType, listener) {
      return eventBus.subscribeChildEvent((event, eventSessionId) => {
        if (eventSessionId !== sessionId || event.type !== eventType) {
          return;
        }
        listener(event);
      });
    },
    dispose() {
      clearInterval(timer);
      ipcServer.dispose();
      runtime.dispose();
      processOptions.adapter.dispose?.();
    },
  });
  sdkRef = sdk;
  return sdk;
}
