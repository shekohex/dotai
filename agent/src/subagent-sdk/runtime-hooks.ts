import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { isStaleSessionReplacementContextError } from "../extensions/session-replacement.js";

import {
  createSubagentDashboardWidget,
  createSubagentFullscreenComponent,
  mergeSubagentsWithTerminalRetention,
} from "./ui.js";
import { isTerminalSubagentStatus } from "./status.js";
import {
  SUBAGENT_MESSAGE_ENTRY,
  SUBAGENT_OVERVIEW_WIDGET_KEY,
  SUBAGENT_STATE_ENTRY,
  SUBAGENT_STATUS_MESSAGE,
  serializeSubagentMessageEntry,
  serializeSubagentStateEntry,
  type RuntimeSubagent,
  type SubagentMessageEntry,
  type SubagentStateEntry,
  type SubagentStatusDetails,
} from "./types.js";

const SUBAGENT_DASHBOARD_SHORTCUT = Key.ctrlAlt("u");
const DEFAULT_TERMINAL_RETENTION_MS = 15_000;

type SubagentRuntimeUiSlot = {
  subagents: RuntimeSubagent[];
  retainedTerminalSubagents: Map<string, RuntimeSubagent>;
  expiryTimers: Map<string, NodeJS.Timeout>;
  title: string;
  terminalRetentionMs: number;
  ctx?: ExtensionContext;
  scopeKey?: string;
};

type SubagentDashboardCoordinator = {
  expanded: boolean;
  registeredControlApi?: ExtensionAPI;
  slots: Map<symbol, SubagentRuntimeUiSlot>;
};

const subagentDashboardCoordinator: SubagentDashboardCoordinator = {
  expanded: false,
  slots: new Map<symbol, SubagentRuntimeUiSlot>(),
};

export function resetSubagentDashboardCoordinatorForTests(): void {
  for (const slot of subagentDashboardCoordinator.slots.values()) {
    for (const timer of slot.expiryTimers.values()) {
      clearTimeout(timer);
    }
  }
  subagentDashboardCoordinator.expanded = false;
  subagentDashboardCoordinator.registeredControlApi = undefined;
  subagentDashboardCoordinator.slots.clear();
}

export type SubagentRuntimeHooks = {
  persistState(state: SubagentStateEntry): Promise<void>;
  persistMessage(entry: SubagentMessageEntry): Promise<void>;
  emitStatusMessage(options: {
    content: string;
    details: SubagentStatusDetails;
    deliverAs?: "steer" | "followUp";
    triggerTurn?: boolean;
  }): void;
  renderWidget(ctx: ExtensionContext | undefined, subagents: RuntimeSubagent[]): void;
  dispose?(): void;
};

export type DefaultSubagentRuntimeHooksOptions = {
  title?: string;
  terminalRetentionMs?: number;
};

type SubagentRuntimeUiControls = {
  toggle(): void;
  setExpanded(nextExpanded: boolean): void;
  showFullscreen(ctx: ExtensionContext): Promise<void>;
};

function toRuntimeSubagent(state: SubagentStateEntry): RuntimeSubagent {
  return {
    ...state,
    modeLabel: state.mode ?? "worker",
  };
}

function getScopeKey(ctx: ExtensionContext): string {
  const sessionId = ctx.sessionManager.getSessionId?.();
  return sessionId === undefined || sessionId.length === 0 ? `cwd:${ctx.cwd}` : sessionId;
}

function hasSubagentRuntimeControlApi(
  pi: ExtensionAPI,
): pi is ExtensionAPI & Pick<ExtensionAPI, "registerCommand" | "registerShortcut"> {
  return typeof pi.registerCommand === "function" && typeof pi.registerShortcut === "function";
}

function registerSubagentRuntimeControls(
  pi: ExtensionAPI,
  controls: SubagentRuntimeUiControls,
): void {
  if (
    !hasSubagentRuntimeControlApi(pi) ||
    subagentDashboardCoordinator.registeredControlApi !== undefined
  ) {
    return;
  }

  subagentDashboardCoordinator.registeredControlApi = pi;

  pi.registerCommand("subagents", {
    description: "Show or toggle live subagent dashboard",
    async handler(args, ctx) {
      const action = args.trim();
      if (action === "fullscreen" || action === "full") {
        await controls.showFullscreen(ctx);
        return;
      }
      if (action === "expand") {
        controls.setExpanded(true);
      } else if (action === "collapse") {
        controls.setExpanded(false);
      } else {
        controls.toggle();
      }
      renderCoordinatedWidget(ctx);
    },
  });

  pi.registerShortcut(SUBAGENT_DASHBOARD_SHORTCUT, {
    description: "Toggle subagent dashboard",
    handler(ctx) {
      controls.toggle();
      renderCoordinatedWidget(ctx);
    },
  });
}

function clearSlotTimers(slot: SubagentRuntimeUiSlot): void {
  for (const timer of slot.expiryTimers.values()) {
    clearTimeout(timer);
  }
  slot.expiryTimers.clear();
}

function createRuntimeUiSlot(options: DefaultSubagentRuntimeHooksOptions): SubagentRuntimeUiSlot {
  return {
    subagents: [],
    retainedTerminalSubagents: new Map<string, RuntimeSubagent>(),
    expiryTimers: new Map<string, NodeJS.Timeout>(),
    title: options.title ?? "Subagents",
    terminalRetentionMs: options.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS,
  };
}

function getScopedSlots(ctx: ExtensionContext): SubagentRuntimeUiSlot[] {
  const scopeKey = getScopeKey(ctx);
  return getScopedSlotsByScopeKey(scopeKey);
}

function getScopedSlotsByScopeKey(scopeKey: string): SubagentRuntimeUiSlot[] {
  return Array.from(subagentDashboardCoordinator.slots.values()).filter(
    (slot) => slot.scopeKey === scopeKey,
  );
}

function getDashboardTitle(slots: SubagentRuntimeUiSlot[]): string {
  const titles = [...new Set(slots.map((slot) => slot.title))];
  return titles.length === 1 ? (titles[0] ?? "Subagents") : "Subagents";
}

function getScopedSubagents(ctx: ExtensionContext): RuntimeSubagent[] {
  return getScopedSubagentsFromSlots(getScopedSlots(ctx));
}

function getScopedSubagentsFromSlots(slots: SubagentRuntimeUiSlot[]): RuntimeSubagent[] {
  const now = Date.now();
  const merged = slots.flatMap((slot) =>
    mergeSubagentsWithTerminalRetention({
      previous: Array.from(slot.retainedTerminalSubagents.values()),
      next: slot.subagents,
      now,
      retentionMs: slot.terminalRetentionMs,
    }),
  );
  return merged
    .filter(
      (subagent, index, all) =>
        all.findIndex((candidate) => candidate.sessionId === subagent.sessionId) === index,
    )
    .toSorted((left, right) => left.startedAt - right.startedAt);
}

function clearContextReferences(ctx: ExtensionContext): void {
  for (const slot of subagentDashboardCoordinator.slots.values()) {
    if (slot.ctx !== ctx) {
      continue;
    }
    slot.ctx = undefined;
    slot.scopeKey = undefined;
  }
}

function renderCoordinatedWidget(ctx: ExtensionContext | undefined): void {
  try {
    if (ctx === undefined || !ctx.hasUI) {
      return;
    }

    const scopeKey = getScopeKey(ctx);
    const scopedSlots = getScopedSlotsByScopeKey(scopeKey);
    const visibleSubagents = getScopedSubagentsFromSlots(scopedSlots);

    ctx.ui.setWidget(
      SUBAGENT_OVERVIEW_WIDGET_KEY,
      visibleSubagents.length === 0
        ? undefined
        : createSubagentDashboardWidget({
            subagents: visibleSubagents,
            title: getDashboardTitle(scopedSlots),
            mode: subagentDashboardCoordinator.expanded ? "expanded" : "compact",
            maxRows: 4,
          }),
      { placement: "aboveEditor" },
    );
  } catch (error) {
    if (!isStaleSessionReplacementContextError(error)) {
      throw error;
    }
    if (ctx !== undefined) {
      clearContextReferences(ctx);
    }
  }
}

function ensureSlotRegistered(slotId: symbol, slot: SubagentRuntimeUiSlot): void {
  if (!subagentDashboardCoordinator.slots.has(slotId)) {
    subagentDashboardCoordinator.slots.set(slotId, slot);
  }
}

function scheduleTerminalExpiry(slot: SubagentRuntimeUiSlot, sessionId: string): void {
  const existingTimer = slot.expiryTimers.get(sessionId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(() => {
    slot.expiryTimers.delete(sessionId);
    slot.retainedTerminalSubagents.delete(sessionId);
    renderCoordinatedWidget(slot.ctx);
  }, slot.terminalRetentionMs);
  timer.unref?.();
  slot.expiryTimers.set(sessionId, timer);
}

function retainTerminalState(slot: SubagentRuntimeUiSlot, state: SubagentStateEntry): void {
  const runtimeState = toRuntimeSubagent(state);
  if (!isTerminalSubagentStatus(runtimeState.status)) {
    slot.retainedTerminalSubagents.delete(runtimeState.sessionId);
    const existingTimer = slot.expiryTimers.get(runtimeState.sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      slot.expiryTimers.delete(runtimeState.sessionId);
    }
    return;
  }

  slot.retainedTerminalSubagents.set(runtimeState.sessionId, runtimeState);
  scheduleTerminalExpiry(slot, runtimeState.sessionId);
  renderCoordinatedWidget(slot.ctx);
}

async function showCoordinatedFullscreen(ctx: ExtensionContext): Promise<void> {
  try {
    if (!ctx.hasUI) {
      return;
    }

    const scopedSlots = getScopedSlots(ctx);
    const visibleSubagents = getScopedSubagentsFromSlots(scopedSlots);
    if (visibleSubagents.length === 0) {
      ctx.ui.notify("No subagents to show", "info");
      return;
    }

    await ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) =>
        createSubagentFullscreenComponent({
          subagents: visibleSubagents,
          getSubagents: () => getScopedSubagents(ctx),
          getTitle: () => getDashboardTitle(getScopedSlots(ctx)),
          title: getDashboardTitle(scopedSlots),
          done,
        })(tui, theme),
      {
        overlay: true,
        overlayOptions: {
          width: "95%",
          maxHeight: "90%",
          anchor: "center",
        },
      },
    );
  } catch (error) {
    if (!isStaleSessionReplacementContextError(error)) {
      throw error;
    }
    clearContextReferences(ctx);
  }
}

export function createDefaultSubagentRuntimeHooks(
  pi: ExtensionAPI,
  options: DefaultSubagentRuntimeHooksOptions = {},
): SubagentRuntimeHooks {
  const slotId = Symbol("subagent-runtime-ui-slot");
  const slot = createRuntimeUiSlot(options);
  subagentDashboardCoordinator.slots.set(slotId, slot);

  const renderMergedWidget = (ctx: ExtensionContext | undefined): void => {
    if (ctx === undefined) {
      return;
    }
    try {
      if (!ctx.hasUI) {
        return;
      }
      ensureSlotRegistered(slotId, slot);
      slot.scopeKey = getScopeKey(ctx);
      slot.ctx = ctx;
      renderCoordinatedWidget(ctx);
    } catch (error) {
      if (!isStaleSessionReplacementContextError(error)) {
        throw error;
      }
      clearContextReferences(ctx);
    }
  };

  registerSubagentRuntimeControls(pi, {
    toggle() {
      subagentDashboardCoordinator.expanded = !subagentDashboardCoordinator.expanded;
    },
    setExpanded(nextExpanded) {
      subagentDashboardCoordinator.expanded = nextExpanded;
    },
    showFullscreen: showCoordinatedFullscreen,
  });

  const dispose = (): void => {
    clearSlotTimers(slot);
    subagentDashboardCoordinator.slots.delete(slotId);
    slot.subagents = [];
    slot.retainedTerminalSubagents.clear();
    renderCoordinatedWidget(slot.ctx);
    slot.ctx = undefined;
    slot.scopeKey = undefined;
  };

  return {
    persistState(state) {
      try {
        ensureSlotRegistered(slotId, slot);
        pi.appendEntry(SUBAGENT_STATE_ENTRY, serializeSubagentStateEntry(state));
        retainTerminalState(slot, state);
      } catch (error) {
        if (!isStaleSessionReplacementContextError(error)) {
          throw error;
        }
      }
      return Promise.resolve();
    },
    persistMessage(entry) {
      try {
        pi.appendEntry(SUBAGENT_MESSAGE_ENTRY, serializeSubagentMessageEntry(entry));
      } catch (error) {
        if (!isStaleSessionReplacementContextError(error)) {
          throw error;
        }
      }
      return Promise.resolve();
    },
    emitStatusMessage({ content, details, deliverAs, triggerTurn }) {
      try {
        pi.sendMessage(
          {
            customType: SUBAGENT_STATUS_MESSAGE,
            content,
            display: true,
            details,
          },
          triggerTurn === true
            ? { deliverAs: deliverAs ?? "steer", triggerTurn: true }
            : { deliverAs: deliverAs ?? "steer" },
        );
      } catch (error) {
        if (!isStaleSessionReplacementContextError(error)) {
          throw error;
        }
      }
    },
    renderWidget(ctx, subagents) {
      slot.subagents = subagents;
      renderMergedWidget(ctx);
    },
    dispose,
  };
}
