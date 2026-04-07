import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import type {
  OpenUsageRuntimeState,
  PersistedOpenUsageState,
  ResetTimeFormat,
  SupportedProviderId,
} from "./types.js";
import { OPENUSAGE_STATE_ENTRY } from "./types.js";

const EMPTY_PERSISTED_STATE: PersistedOpenUsageState = {
  selectedAccounts: {},
  resetTimeFormat: "relative",
};

export function createRuntimeState(): OpenUsageRuntimeState {
  return {
    persisted: { ...EMPTY_PERSISTED_STATE, selectedAccounts: {} },
    snapshots: new Map(),
    inFlight: new Map(),
    notifiedAlerts: new Set(),
  };
}

export function restorePersistedState(
  entries: SessionEntry[],
): PersistedOpenUsageState {
  let latest: PersistedOpenUsageState | undefined;

  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== OPENUSAGE_STATE_ENTRY) {
      continue;
    }

    const data = entry.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      continue;
    }

    const selectedAccounts = normalizeSelectedAccounts(
      (data as { selectedAccounts?: unknown }).selectedAccounts,
    );
    const resetTimeFormat = normalizeResetTimeFormat(
      (data as { resetTimeFormat?: unknown }).resetTimeFormat,
    );

    latest = {
      selectedAccounts,
      resetTimeFormat: resetTimeFormat ?? EMPTY_PERSISTED_STATE.resetTimeFormat,
    };
  }

  return latest ?? { ...EMPTY_PERSISTED_STATE, selectedAccounts: {} };
}

export function setSelectedAccount(
  state: OpenUsageRuntimeState,
  providerId: SupportedProviderId,
  value: string | undefined,
): PersistedOpenUsageState {
  const nextSelectedAccounts = { ...state.persisted.selectedAccounts };

  if (!value) {
    delete nextSelectedAccounts[providerId];
  } else {
    nextSelectedAccounts[providerId] = value;
  }

  state.persisted = {
    ...state.persisted,
    selectedAccounts: nextSelectedAccounts,
  };

  return state.persisted;
}

export function setResetTimeFormat(
  state: OpenUsageRuntimeState,
  value: ResetTimeFormat,
): PersistedOpenUsageState {
  state.persisted = {
    ...state.persisted,
    resetTimeFormat: value,
  };

  return state.persisted;
}

function normalizeSelectedAccounts(
  value: unknown,
): Partial<Record<SupportedProviderId, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const next: Partial<Record<SupportedProviderId, string>> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isSupportedProviderId(key) || typeof raw !== "string") {
      continue;
    }

    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }

    next[key] = trimmed;
  }

  return next;
}

function normalizeResetTimeFormat(value: unknown): ResetTimeFormat | undefined {
  if (value !== "relative" && value !== "absolute") {
    return undefined;
  }

  return value;
}

function isSupportedProviderId(value: string): value is SupportedProviderId {
  return value === "codex" || value === "zai" || value === "opencode-go";
}
