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

const coordinatorsByApi = new WeakMap<ExtensionAPI, SubagentDashboardCoordinator>();
const coordinators = new Set<SubagentDashboardCoordinator>();

function getSubagentDashboardCoordinator(pi: ExtensionAPI): SubagentDashboardCoordinator {
  let coordinator = coordinatorsByApi.get(pi);
  if (coordinator === undefined) {
    coordinator = { expanded: false, slots: new Map() };
    coordinatorsByApi.set(pi, coordinator);
    coordinators.add(coordinator);
  }
  return coordinator;
}

export function resetSubagentDashboardCoordinatorForTests(): void {
  for (const coordinator of coordinators) {
    for (const slot of coordinator.slots.values()) {
      for (const timer of slot.expiryTimers.values()) {
        clearTimeout(timer);
      }
    }
    coordinator.expanded = false;
    coordinator.registeredControlApi = undefined;
    coordinator.slots.clear();
  }
  coordinators.clear();
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
  registerControls?: boolean;
  toolControl?: {
    getDefaultEnabled?(): boolean;
    isEnabled(): boolean;
    setEnabled(enabled: boolean, ctx: ExtensionContext): void;
  };
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
  coordinator: SubagentDashboardCoordinator,
  controls: SubagentRuntimeUiControls,
  toolControl?: DefaultSubagentRuntimeHooksOptions["toolControl"],
): void {
  if (!hasSubagentRuntimeControlApi(pi) || coordinator.registeredControlApi !== undefined) {
    return;
  }

  coordinator.registeredControlApi = pi;

  pi.registerCommand("subagents", {
    description: "Enable or disable subagent tool, or control live subagent dashboard",
    getArgumentCompletions(prefix) {
      const trimmed = prefix.trim();
      return [
        { value: "on", label: "on", description: "Enable subagent tool for this session" },
        { value: "off", label: "off", description: "Disable subagent tool for this session" },
        { value: "status", label: "status", description: "Show subagent tool status" },
        { value: "fullscreen", label: "fullscreen", description: "Open subagent dashboard" },
      ].filter((item) => item.value.startsWith(trimmed));
    },
    async handler(args, ctx) {
      const action = args.trim();
      if (action === "on" || action === "off") {
        const enabled = action === "on";
        toolControl?.setEnabled(enabled, ctx);
        ctx.ui.notify(`subagent tool ${enabled ? "enabled" : "disabled"}.`, "info");
        return;
      }
      if (action === "status") {
        const configEnabled = toolControl?.getDefaultEnabled?.();
        ctx.ui.notify(
          `subagent: ${toolControl?.isEnabled() === false ? "disabled" : "enabled"}${configEnabled === undefined ? "" : ` (config default: ${configEnabled ? "enabled" : "disabled"})`}`,
          "info",
        );
        return;
      }
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
      renderCoordinatedWidget(coordinator, ctx);
    },
  });

  pi.registerShortcut(SUBAGENT_DASHBOARD_SHORTCUT, {
    description: "Toggle subagent dashboard",
    handler(ctx) {
      controls.toggle();
      renderCoordinatedWidget(coordinator, ctx);
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

function getScopedSlots(
  coordinator: SubagentDashboardCoordinator,
  ctx: ExtensionContext,
): SubagentRuntimeUiSlot[] {
  const scopeKey = getScopeKey(ctx);
  return getScopedSlotsByScopeKey(coordinator, scopeKey);
}

function getScopedSlotsByScopeKey(
  coordinator: SubagentDashboardCoordinator,
  scopeKey: string,
): SubagentRuntimeUiSlot[] {
  return Array.from(coordinator.slots.values()).filter((slot) => slot.scopeKey === scopeKey);
}

function getDashboardTitle(slots: SubagentRuntimeUiSlot[]): string {
  const titles = [...new Set(slots.map((slot) => slot.title))];
  return titles.length === 1 ? (titles[0] ?? "Subagents") : "Subagents";
}

function getScopedSubagents(
  coordinator: SubagentDashboardCoordinator,
  ctx: ExtensionContext,
): RuntimeSubagent[] {
  return getScopedSubagentsFromSlots(getScopedSlots(coordinator, ctx));
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

function clearContextReferences(
  coordinator: SubagentDashboardCoordinator,
  ctx: ExtensionContext,
): void {
  for (const slot of coordinator.slots.values()) {
    if (slot.ctx !== ctx) {
      continue;
    }
    slot.ctx = undefined;
    slot.scopeKey = undefined;
  }
}

function renderCoordinatedWidget(
  coordinator: SubagentDashboardCoordinator,
  ctx: ExtensionContext | undefined,
): void {
  try {
    if (ctx === undefined || !ctx.hasUI) {
      return;
    }

    const scopeKey = getScopeKey(ctx);
    const scopedSlots = getScopedSlotsByScopeKey(coordinator, scopeKey);
    const visibleSubagents = getScopedSubagentsFromSlots(scopedSlots);

    ctx.ui.setWidget(
      SUBAGENT_OVERVIEW_WIDGET_KEY,
      visibleSubagents.length === 0
        ? undefined
        : createSubagentDashboardWidget({
            subagents: visibleSubagents,
            title: getDashboardTitle(scopedSlots),
            mode: coordinator.expanded ? "expanded" : "compact",
            maxRows: 4,
          }),
      { placement: "aboveEditor" },
    );
  } catch (error) {
    if (!isStaleSessionReplacementContextError(error)) {
      throw error;
    }
    if (ctx !== undefined) {
      clearContextReferences(coordinator, ctx);
    }
  }
}

function ensureSlotRegistered(
  coordinator: SubagentDashboardCoordinator,
  slotId: symbol,
  slot: SubagentRuntimeUiSlot,
): void {
  if (!coordinator.slots.has(slotId)) {
    coordinator.slots.set(slotId, slot);
  }
}

function scheduleTerminalExpiry(
  coordinator: SubagentDashboardCoordinator,
  slot: SubagentRuntimeUiSlot,
  sessionId: string,
): void {
  const existingTimer = slot.expiryTimers.get(sessionId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(() => {
    slot.expiryTimers.delete(sessionId);
    slot.retainedTerminalSubagents.delete(sessionId);
    renderCoordinatedWidget(coordinator, slot.ctx);
  }, slot.terminalRetentionMs);
  timer.unref?.();
  slot.expiryTimers.set(sessionId, timer);
}

function retainTerminalState(
  coordinator: SubagentDashboardCoordinator,
  slot: SubagentRuntimeUiSlot,
  state: SubagentStateEntry,
): void {
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
  scheduleTerminalExpiry(coordinator, slot, runtimeState.sessionId);
  renderCoordinatedWidget(coordinator, slot.ctx);
}

async function showCoordinatedFullscreen(
  coordinator: SubagentDashboardCoordinator,
  ctx: ExtensionContext,
): Promise<void> {
  try {
    if (!ctx.hasUI) {
      return;
    }

    const scopedSlots = getScopedSlots(coordinator, ctx);
    const visibleSubagents = getScopedSubagentsFromSlots(scopedSlots);
    if (visibleSubagents.length === 0) {
      ctx.ui.notify("No subagents to show", "info");
      return;
    }

    await ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) =>
        createSubagentFullscreenComponent({
          subagents: visibleSubagents,
          getSubagents: () => getScopedSubagents(coordinator, ctx),
          getTitle: () => getDashboardTitle(getScopedSlots(coordinator, ctx)),
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
    clearContextReferences(coordinator, ctx);
  }
}

export function createDefaultSubagentRuntimeHooks(
  pi: ExtensionAPI,
  options: DefaultSubagentRuntimeHooksOptions = {},
): SubagentRuntimeHooks {
  const coordinator = getSubagentDashboardCoordinator(pi);
  const slotId = Symbol("subagent-runtime-ui-slot");
  const slot = createRuntimeUiSlot(options);
  coordinator.slots.set(slotId, slot);

  const renderMergedWidget = (ctx: ExtensionContext | undefined): void => {
    if (ctx === undefined) {
      return;
    }
    try {
      if (!ctx.hasUI) {
        return;
      }
      ensureSlotRegistered(coordinator, slotId, slot);
      slot.scopeKey = getScopeKey(ctx);
      slot.ctx = ctx;
      renderCoordinatedWidget(coordinator, ctx);
    } catch (error) {
      if (!isStaleSessionReplacementContextError(error)) {
        throw error;
      }
      clearContextReferences(coordinator, ctx);
    }
  };

  if (options.registerControls === true) {
    registerSubagentRuntimeControls(
      pi,
      coordinator,
      {
        toggle() {
          coordinator.expanded = !coordinator.expanded;
        },
        setExpanded(nextExpanded) {
          coordinator.expanded = nextExpanded;
        },
        showFullscreen: (ctx) => showCoordinatedFullscreen(coordinator, ctx),
      },
      options.toolControl,
    );
  }

  const dispose = (): void => {
    clearSlotTimers(slot);
    coordinator.slots.delete(slotId);
    slot.subagents = [];
    slot.retainedTerminalSubagents.clear();
    renderCoordinatedWidget(coordinator, slot.ctx);
    slot.ctx = undefined;
    slot.scopeKey = undefined;
  };

  return {
    persistState(state) {
      try {
        ensureSlotRegistered(coordinator, slotId, slot);
        pi.appendEntry(SUBAGENT_STATE_ENTRY, serializeSubagentStateEntry(state));
        retainTerminalState(coordinator, slot, state);
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
