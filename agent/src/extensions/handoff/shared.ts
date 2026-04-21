import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type {
  ResolvedSessionLaunchOptions,
  SessionLaunchOptions,
} from "../session-launch-utils.js";
import { MODE_SELECTION_APPLY_EVENT } from "../modes.js";

export type HandoffOptions = SessionLaunchOptions;
export type ResolvedHandoffOptions = ResolvedSessionLaunchOptions;

type PendingToolHandoff = {
  prompt: string;
  parentSession?: string;
  overrides?: ResolvedHandoffOptions;
};

type PendingSessionHandoff = {
  prompt: string;
  autoSend: boolean;
  overrides?: ResolvedHandoffOptions;
};

declare global {
  var __shekohexPendingSessionHandoff: PendingSessionHandoff | undefined;
}

export type HandoffRuntimeState = {
  ctx?: ExtensionContext;
  pendingNewSessionCtx?: {
    promise: Promise<ExtensionContext>;
    resolve: (ctx: ExtensionContext) => void;
  };
};

export type HandoffLaunchResult =
  | { status: "started"; warning?: string }
  | { status: "cancelled" }
  | { status: "error"; error: string };

const pendingToolHandoffState: {
  pending: PendingToolHandoff | undefined;
  contextCutoffTimestamp: number | undefined;
} = {
  pending: undefined,
  contextCutoffTimestamp: undefined,
};

type MutableSessionManager = {
  newSession: (options?: { parentSession?: string }) => string | undefined;
};

function readNewSessionMethod(
  manager: ExtensionContext["sessionManager"],
): MutableSessionManager["newSession"] | undefined {
  const candidate = (manager as Record<string, unknown>)["newSession"];
  if (typeof candidate !== "function") {
    return undefined;
  }
  return (options: { parentSession?: string } = {}) => {
    const result: unknown = candidate.call(manager, options);
    return typeof result === "string" ? result : undefined;
  };
}

function getPendingCommandHandoff(): PendingSessionHandoff | undefined {
  return globalThis.__shekohexPendingSessionHandoff;
}

function setPendingCommandHandoff(pending: PendingSessionHandoff | undefined): void {
  globalThis.__shekohexPendingSessionHandoff = pending;
}

function startNewSessionInPlace(ctx: ExtensionContext, parentSession?: string): string | undefined {
  const newSession = readNewSessionMethod(ctx.sessionManager);
  if (!newSession) {
    throw new TypeError("SessionManager newSession is unavailable");
  }
  return newSession({ parentSession });
}

async function applyPendingSelection(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  overrides?: ResolvedHandoffOptions,
): Promise<void> {
  if (!overrides) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    pi.events.emit(MODE_SELECTION_APPLY_EVENT, {
      ctx,
      mode: overrides.mode,
      targetModel: overrides.targetModel,
      thinkingLevel: overrides.thinkingLevel,
      reason: "restore",
      source: "session_start",
      done: { resolve, reject },
    });
  });
}

function createPendingNewSessionContext(state: HandoffRuntimeState): Promise<ExtensionContext> {
  if (state.pendingNewSessionCtx) {
    return state.pendingNewSessionCtx.promise;
  }

  let resolvePromise: ((ctx: ExtensionContext) => void) | undefined;
  const promise = new Promise<ExtensionContext>((resolve) => {
    resolvePromise = resolve;
  });

  state.pendingNewSessionCtx = {
    promise,
    resolve: (ctx) => {
      resolvePromise?.(ctx);
      state.pendingNewSessionCtx = undefined;
    },
  };

  return promise;
}

function waitForPendingNewSessionContext(
  state: HandoffRuntimeState,
  fallbackCtx: ExtensionContext,
): Promise<ExtensionContext> {
  const pending = state.pendingNewSessionCtx;
  if (!pending) {
    return Promise.resolve(state.ctx ?? fallbackCtx);
  }

  return Promise.race([
    pending.promise,
    new Promise<ExtensionContext>((resolve) => {
      setTimeout(() => {
        resolve(state.ctx ?? fallbackCtx);
      }, 500);
    }),
  ]);
}

export {
  applyPendingSelection,
  createPendingNewSessionContext,
  getPendingCommandHandoff,
  pendingToolHandoffState,
  setPendingCommandHandoff,
  startNewSessionInPlace,
  waitForPendingNewSessionContext,
};
