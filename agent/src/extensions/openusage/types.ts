import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export const OPENUSAGE_STATE_ENTRY = "openusage-state";
export const OPENUSAGE_STATUS_KEY = "openusage";
export const OPENUSAGE_UPDATED_EVENT = "openusage:updated";
export const OPENUSAGE_ALERT_EVENT = "openusage:alert";
export const OPENUSAGE_REFRESH_INTERVAL_MS = 300_000;
export const OPENUSAGE_CACHE_TTL_MS = 45_000;
export const OPENUSAGE_SESSION_ALERT_THRESHOLD_PERCENT = 20;
export const OPENUSAGE_WEEKLY_ALERT_THRESHOLD_PERCENT = 15;
export const CLIPROXY_AUTH_PROVIDER = "cliproxyapi";

export const SUPPORTED_PROVIDER_IDS = ["codex", "google", "zai"] as const;

export type SupportedProviderId = (typeof SUPPORTED_PROVIDER_IDS)[number];

export function isSupportedProviderId(
  value: string,
): value is SupportedProviderId {
  return value === "codex" || value === "google" || value === "zai";
}

export type UsageMetric = {
  used: number;
  limit: number;
  resetsAt?: string;
  periodDurationMs?: number;
};

export type UsageSnapshot = {
  providerId: SupportedProviderId;
  displayName: string;
  plan?: string;
  source: "host" | "cliproxy";
  accountLabel?: string;
  session5h?: UsageMetric;
  weekly?: UsageMetric;
  metricLabels?: Partial<Record<OpenUsageMetricKind, string>>;
  metricShortLabels?: Partial<Record<OpenUsageMetricKind, string>>;
  fetchedAt: number;
  summary?: string;
};

export type ResetTimeFormat = "relative" | "absolute";

export type OpenUsageMetricKind = "session5h" | "weekly";

export type PersistedOpenUsageState = {
  selectedAccounts: Partial<Record<SupportedProviderId, string>>;
  resetTimeFormat: ResetTimeFormat;
};

export type OpenUsageRuntimeState = {
  persisted: PersistedOpenUsageState;
  snapshots: Map<SupportedProviderId, UsageSnapshot>;
  inFlight: Map<SupportedProviderId, Promise<UsageSnapshot>>;
  notifiedAlerts: Set<string>;
  interval?: ReturnType<typeof setInterval>;
};

export type CliproxyConfig = {
  baseUrl: string;
  apiKey: string;
};

export type CliproxyAuthFile = {
  id: string;
  name: string;
  provider: string;
  email?: string;
  authIndex?: string;
  disabled: boolean;
  unavailable: boolean;
  runtimeOnly: boolean;
};

export type CliproxyAccount = {
  value: string;
  label: string;
  file: CliproxyAuthFile;
};

export type CliproxyAccountsByProvider = Partial<
  Record<SupportedProviderId, CliproxyAccount[]>
>;

export type OpenUsageUpdatedEvent = {
  providerId?: SupportedProviderId;
  active: boolean;
  snapshot?: UsageSnapshot;
};

export type OpenUsageAlertEvent = {
  providerId: SupportedProviderId;
  displayName: string;
  metric: OpenUsageMetricKind;
  remainingPercent: number;
  thresholdPercent: number;
  resetsAt?: string;
  snapshot: UsageSnapshot;
};

export type UsageProvider = {
  id: SupportedProviderId;
  displayName: string;
  matchesModel(provider: string, modelId: string): boolean;
  fetchSnapshot(
    ctx: ExtensionContext,
    state: OpenUsageRuntimeState,
  ): Promise<UsageSnapshot>;
};
