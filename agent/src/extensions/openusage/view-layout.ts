import type { Theme } from "@mariozechner/pi-coding-agent";
import { getMetricLabel, maskAccountLabel, type OpenUsageDisplayMode } from "./status.js";
import type { ResetTimeFormat, SupportedProviderId, UsageSnapshot } from "./types.js";
import { formatAge, providerDisplayName, renderMetricSection } from "./view-metrics.js";

type OpenUsageAccountOption = {
  label: string;
  value?: string;
  source: "host" | "cliproxy";
};

function buildOpenUsageLines(input: {
  theme: Theme;
  providerIds: SupportedProviderId[];
  selectedProviderId: SupportedProviderId;
  displayMode: OpenUsageDisplayMode;
  resetTimeFormat: ResetTimeFormat;
  activeProviderId?: SupportedProviderId;
  activeModelLabel?: string;
  account: { options: OpenUsageAccountOption[]; option: OpenUsageAccountOption; index: number };
  snapshot: UsageSnapshot | undefined;
  busyMessage?: string;
  errorMessage?: string;
  width: number;
}): string[] {
  const sourceLabel = input.account.option.source === "cliproxy" ? "CLIProxyAPI" : "host auth";
  return [
    ...buildControlLines(
      input.theme,
      input.providerIds,
      input.selectedProviderId,
      input.displayMode,
      input.resetTimeFormat,
    ),
    ...buildProviderSectionLines(input, sourceLabel),
    ...buildMetricLines(
      input.theme,
      input.snapshot,
      input.width,
      input.resetTimeFormat,
      input.displayMode,
    ),
  ];
}

function buildControlLines(
  theme: Theme,
  providerIds: SupportedProviderId[],
  selectedProviderId: SupportedProviderId,
  displayMode: OpenUsageDisplayMode,
  resetTimeFormat: ResetTimeFormat,
): string[] {
  const muted = (s: string) => theme.fg("muted", s);
  const dim = (s: string) => theme.fg("dim", s);
  const bold = (s: string) => theme.bold(s);

  const providerTab = (providerId: SupportedProviderId): string => {
    const selected = providerId === selectedProviderId;
    const label = providerDisplayName(providerId);
    return selected ? bold(`[${label}]`) : dim(` ${label} `);
  };
  const modeTab = (mode: OpenUsageDisplayMode): string =>
    mode === displayMode ? bold(`[${mode}]`) : dim(` ${mode} `);
  const resetTab = (mode: ResetTimeFormat): string =>
    mode === resetTimeFormat ? bold(`[${mode}]`) : dim(` ${mode} `);

  return [
    `${muted("Providers ")}${providerIds.map((providerId) => providerTab(providerId)).join("")}` +
      `${muted("  mode ")}${modeTab("left")}${modeTab("used")}` +
      `${muted("  reset ")}${resetTab("relative")}${resetTab("absolute")}`,
    muted("←/→ provider · tab used/left · a/A account · r reset · f refresh · q close"),
    "",
  ];
}

function buildProviderSectionLines(
  input: {
    theme: Theme;
    selectedProviderId: SupportedProviderId;
    activeProviderId?: SupportedProviderId;
    activeModelLabel?: string;
    account: { options: OpenUsageAccountOption[]; option: OpenUsageAccountOption; index: number };
    snapshot: UsageSnapshot | undefined;
    busyMessage?: string;
    errorMessage?: string;
  },
  sourceLabel: string,
): string[] {
  const muted = (s: string) => input.theme.fg("muted", s);
  const text = (s: string) => input.theme.fg("text", s);
  const dim = (s: string) => input.theme.fg("dim", s);
  const lines: string[] = [
    muted("Provider: ") + text(providerDisplayName(input.selectedProviderId)),
  ];
  if (
    input.activeModelLabel !== undefined &&
    input.activeModelLabel.length > 0 &&
    input.activeProviderId === input.selectedProviderId
  ) {
    lines.push(muted("Model: ") + text(input.activeModelLabel));
  }
  lines.push(muted("Source: ") + text(sourceLabel));

  appendProviderAccountLine(lines, input, muted, text);
  appendProviderSnapshotLines(lines, input, sourceLabel, muted, text);
  appendProviderStatusLines(lines, input, muted, dim);
  lines.push("");
  return lines;
}

function appendProviderAccountLine(
  lines: string[],
  input: {
    account: { options: OpenUsageAccountOption[]; option: OpenUsageAccountOption; index: number };
  },
  muted: (s: string) => string,
  text: (s: string) => string,
): void {
  if (input.account.option.label.length === 0) {
    return;
  }
  lines.push(
    muted("Account: ") +
      text(maskAccountLabel(input.account.option.label) ?? input.account.option.label) +
      muted(` (${input.account.index + 1}/${input.account.options.length})`),
  );
}

function appendProviderSnapshotLines(
  lines: string[],
  input: {
    snapshot: UsageSnapshot | undefined;
  },
  sourceLabel: string,
  muted: (s: string) => string,
  text: (s: string) => string,
): void {
  if (input.snapshot?.plan !== undefined && input.snapshot.plan.length > 0) {
    lines.push(muted("Plan: ") + text(input.snapshot.plan));
  }
  if (input.snapshot) {
    lines.push(muted("Fetched: ") + text(formatAge(input.snapshot.fetchedAt)));
  }
  if (
    input.snapshot?.summary !== undefined &&
    input.snapshot.summary.length > 0 &&
    input.snapshot.summary !== sourceLabel
  ) {
    lines.push(muted("Summary: ") + text(input.snapshot.summary));
  }
}

function appendProviderStatusLines(
  lines: string[],
  input: {
    theme: Theme;
    busyMessage?: string;
    errorMessage?: string;
  },
  muted: (s: string) => string,
  dim: (s: string) => string,
): void {
  if (input.busyMessage !== undefined && input.busyMessage.length > 0) {
    lines.push(muted("Status: ") + dim(input.busyMessage));
  }
  if (input.errorMessage !== undefined && input.errorMessage.length > 0) {
    lines.push(muted("Error: ") + input.theme.fg("error", input.errorMessage));
  }
}

function buildMetricLines(
  theme: Theme,
  snapshot: UsageSnapshot | undefined,
  width: number,
  resetTimeFormat: ResetTimeFormat,
  displayMode: OpenUsageDisplayMode,
): string[] {
  const dim = (s: string) => theme.fg("dim", s);
  if (snapshot === undefined) {
    return [dim("No cached usage for provider. Press f to fetch.")];
  }

  return [
    ...renderMetricSection(
      theme,
      getMetricLabel(snapshot, "session5h"),
      snapshot.session5h,
      width,
      resetTimeFormat,
      displayMode,
    ),
    "",
    ...renderMetricSection(
      theme,
      getMetricLabel(snapshot, "weekly"),
      snapshot.weekly,
      width,
      resetTimeFormat,
      displayMode,
    ),
  ];
}

export { buildOpenUsageLines };
export type { OpenUsageAccountOption };
