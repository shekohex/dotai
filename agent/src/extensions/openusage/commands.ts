import { DynamicBorder, type ExtensionAPI, type ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Container, Key, Text, matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@mariozechner/pi-tui";
import { listCliproxyAccounts, resolveCliproxyState } from "./cliproxy.js";
import { resolveSupportedProviderId } from "./model-map.js";
import {
  formatReset,
  formatRemainingPercent,
  formatSnapshotSummary,
  formatUsedPercent,
  getMetricLabel,
  getMetricPaceDetails,
  getRemainingPercent,
  maskAccountLabel,
  type OpenUsageDisplayMode,
  type PaceStatus,
} from "./status.js";
import { setResetTimeFormat, setSelectedAccount } from "./state.js";
import type {
  CliproxyAccountsByProvider,
  OpenUsageRuntimeState,
  ResetTimeFormat,
  SupportedProviderId,
  UsageMetric,
  UsageSnapshot,
} from "./types.js";
import {
  isSupportedProviderId,
  OPENUSAGE_STATE_ENTRY,
  SUPPORTED_PROVIDER_IDS,
} from "./types.js";

type OpenUsageViewData = {
  state: OpenUsageRuntimeState;
  accountsByProvider: CliproxyAccountsByProvider;
  providerIds: SupportedProviderId[];
  initialProviderId: SupportedProviderId;
  activeProviderId?: SupportedProviderId;
  activeModelLabel?: string;
  refreshProvider: (
    providerId: SupportedProviderId,
    options?: { force?: boolean },
  ) => Promise<void>;
  persistState: () => void;
};

type OpenUsageAccountOption = {
  label: string;
  value?: string;
  source: "host" | "cliproxy";
};

class OpenUsageView implements Component {
  private tui: TUI;
  private theme: any;
  private onDone: () => void;
  private data: OpenUsageViewData;
  private container: Container;
  private body: Text;
  private cachedWidth?: number;
  private selectedProviderId: SupportedProviderId;
  private displayMode: OpenUsageDisplayMode = "left";
  private busyMessage?: string;
  private errorMessage?: string;

  constructor(tui: TUI, theme: any, data: OpenUsageViewData, onDone: () => void) {
    this.tui = tui;
    this.theme = theme;
    this.data = data;
    this.onDone = onDone;
    this.selectedProviderId = data.initialProviderId;

    this.container = new Container();
    this.container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
    this.container.addChild(
      new Text(
        theme.fg("accent", theme.bold("OpenUsage")) + theme.fg("dim", "  (Esc/q/Enter to close)"),
        1,
        0,
      ),
    );
    this.container.addChild(new Text("", 1, 0));

    this.body = new Text("", 1, 0);
    this.container.addChild(this.body);

    this.container.addChild(new Text("", 1, 0));
    this.container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

    void this.ensureSelectedSnapshot();
  }

  private rebuild(width: number): void {
    const muted = (s: string) => this.theme.fg("muted", s);
    const text = (s: string) => this.theme.fg("text", s);
    const dim = (s: string) => this.theme.fg("dim", s);
    const bold = (s: string) => this.theme.bold(s);
    const lines: string[] = [];

    const providerTab = (providerId: SupportedProviderId): string => {
      const selected = providerId === this.selectedProviderId;
      const label = providerDisplayName(providerId);
      return selected ? bold(`[${label}]`) : dim(` ${label} `);
    };

    const modeTab = (mode: OpenUsageDisplayMode): string => {
      return mode === this.displayMode ? bold(`[${mode}]`) : dim(` ${mode} `);
    };

    const resetTab = (mode: ResetTimeFormat): string => {
      return mode === this.data.state.persisted.resetTimeFormat ? bold(`[${mode}]`) : dim(` ${mode} `);
    };

    lines.push(
      `${muted("Providers ")}${this.data.providerIds.map(providerTab).join("")}` +
      `${muted("  mode ")}${modeTab("left")}${modeTab("used")}` +
      `${muted("  reset ")}${resetTab("relative")}${resetTab("absolute")}`,
    );
    lines.push(muted("←/→ provider · tab used/left · a/A account · r reset · f refresh · q close"));
    lines.push("");

    const snapshot = this.getSelectedSnapshot();
    const account = this.getCurrentAccountSelection();
    const sourceLabel = account.option.source === "cliproxy" ? "CLIProxyAPI" : "host auth";

    lines.push(muted("Provider: ") + text(providerDisplayName(this.selectedProviderId)));
    if (this.data.activeModelLabel && this.data.activeProviderId === this.selectedProviderId) {
      lines.push(muted("Model: ") + text(this.data.activeModelLabel));
    }
    lines.push(muted("Source: ") + text(sourceLabel));

    if (account.option.label) {
      lines.push(
        muted("Account: ") +
        text(maskAccountLabel(account.option.label) ?? account.option.label) +
        muted(` (${account.index + 1}/${account.options.length})`),
      );
    }

    if (snapshot?.plan) {
      lines.push(muted("Plan: ") + text(snapshot.plan));
    }

    if (snapshot) {
      lines.push(muted("Fetched: ") + text(formatAge(snapshot.fetchedAt)));
    }

    if (snapshot?.summary && snapshot.summary !== sourceLabel) {
      lines.push(muted("Summary: ") + text(snapshot.summary));
    }

    if (this.busyMessage) {
      lines.push(muted("Status: ") + dim(this.busyMessage));
    }

    if (this.errorMessage) {
      lines.push(muted("Error: ") + this.theme.fg("error", this.errorMessage));
    }

    lines.push("");
    if (!snapshot) {
      lines.push(dim(`No cached usage for ${this.selectedProviderId}. Press f to fetch.`));
    } else {
      lines.push(
        ...renderMetricSection(
          this.theme,
          getMetricLabel(snapshot, "session5h"),
          snapshot.session5h,
          width,
          this.data.state.persisted.resetTimeFormat,
          this.displayMode,
        ),
      );
      lines.push("");
      lines.push(
        ...renderMetricSection(
          this.theme,
          getMetricLabel(snapshot, "weekly"),
          snapshot.weekly,
          width,
          this.data.state.persisted.resetTimeFormat,
          this.displayMode,
        ),
      );
    }

    this.body.setText(lines.join("\n"));
    this.cachedWidth = width;
  }

  private getSelectedSnapshot(): UsageSnapshot | undefined {
    return this.data.state.snapshots.get(this.selectedProviderId);
  }

  private getAccountOptions(providerId = this.selectedProviderId): OpenUsageAccountOption[] {
    const cliproxyAccounts = this.data.accountsByProvider[providerId] ?? [];
    return [
      { label: `Host auth (${providerId})`, source: "host" },
      ...cliproxyAccounts.map((account) => ({
        label: `CLIProxyAPI: ${account.label}`,
        value: account.value,
        source: "cliproxy" as const,
      })),
    ];
  }

  private getCurrentAccountSelection(providerId = this.selectedProviderId): {
    options: OpenUsageAccountOption[];
    option: OpenUsageAccountOption;
    index: number;
  } {
    const options = this.getAccountOptions(providerId);
    const selectedValue = this.data.state.persisted.selectedAccounts[providerId]?.trim();
    const index = selectedValue
      ? Math.max(0, options.findIndex((option) => option.value === selectedValue))
      : 0;
    return {
      options,
      option: options[index] ?? options[0]!,
      index,
    };
  }

  private cycleProvider(direction: number): void {
    const index = this.data.providerIds.indexOf(this.selectedProviderId);
    this.selectedProviderId =
      this.data.providerIds[(index + this.data.providerIds.length + direction) % this.data.providerIds.length] ??
      this.selectedProviderId;
    this.errorMessage = undefined;
    this.invalidate();
    this.tui.requestRender();
    void this.ensureSelectedSnapshot();
  }

  private toggleDisplayMode(direction: number): void {
    const modes: OpenUsageDisplayMode[] = ["left", "used"];
    const index = modes.indexOf(this.displayMode);
    this.displayMode = modes[(index + modes.length + direction) % modes.length] ?? "left";
    this.invalidate();
    this.tui.requestRender();
  }

  private toggleResetTimeFormat(): void {
    const next: ResetTimeFormat = this.data.state.persisted.resetTimeFormat === "relative" ? "absolute" : "relative";
    setResetTimeFormat(this.data.state, next);
    this.data.persistState();
    this.invalidate();
    this.tui.requestRender();
  }

  private async ensureSelectedSnapshot(): Promise<void> {
    if (this.getSelectedSnapshot()) {
      return;
    }

    await this.refreshSelectedProvider(false);
  }

  private async refreshSelectedProvider(force: boolean): Promise<void> {
    if (this.busyMessage) {
      return;
    }

    const providerId = this.selectedProviderId;
    this.busyMessage = `${force ? "Refreshing" : "Loading"} ${providerId}…`;
    this.errorMessage = undefined;
    this.invalidate();
    this.tui.requestRender();

    try {
      await this.data.refreshProvider(providerId, { force });
    } catch (error) {
      this.errorMessage = formatError(error);
    } finally {
      this.busyMessage = undefined;
      this.invalidate();
      this.tui.requestRender();
    }
  }

  private async cycleAccount(direction: number): Promise<void> {
    if (this.busyMessage) {
      return;
    }

    const providerId = this.selectedProviderId;
    const current = this.getCurrentAccountSelection(providerId);
    if (current.options.length <= 1) {
      this.errorMessage = `No alternate accounts for ${providerId}`;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    const nextIndex = (current.index + current.options.length + direction) % current.options.length;
    const next = current.options[nextIndex] ?? current.option;
    const previousValue = this.data.state.persisted.selectedAccounts[providerId];

    this.busyMessage = `Switching ${providerId} account…`;
    this.errorMessage = undefined;
    setSelectedAccount(this.data.state, providerId, next.value);
    this.data.persistState();
    this.invalidate();
    this.tui.requestRender();

    try {
      await this.data.refreshProvider(providerId, { force: true });
    } catch (error) {
      setSelectedAccount(this.data.state, providerId, previousValue);
      this.data.persistState();
      this.errorMessage = formatError(error);
    } finally {
      this.busyMessage = undefined;
      this.invalidate();
      this.tui.requestRender();
    }
  }

  handleInput(data: string): void {
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("c")) ||
      data.toLowerCase() === "q" ||
      data === "\r"
    ) {
      this.onDone();
      return;
    }

    if (matchesKey(data, Key.left) || data.toLowerCase() === "h") {
      this.cycleProvider(-1);
      return;
    }

    if (matchesKey(data, Key.right) || data.toLowerCase() === "l") {
      this.cycleProvider(1);
      return;
    }

    if (matchesKey(data, Key.tab) || data.toLowerCase() === "t") {
      this.toggleDisplayMode(1);
      return;
    }

    if (matchesKey(data, Key.shift("tab"))) {
      this.toggleDisplayMode(-1);
      return;
    }

    if (data === "r") {
      this.toggleResetTimeFormat();
      return;
    }

    if (data === "f") {
      void this.refreshSelectedProvider(true);
      return;
    }

    if (data === "a") {
      void this.cycleAccount(1);
      return;
    }

    if (data === "A") {
      void this.cycleAccount(-1);
      return;
    }

    if (data === "1") {
      this.selectedProviderId = this.data.providerIds[0] ?? this.selectedProviderId;
      this.invalidate();
      this.tui.requestRender();
      void this.ensureSelectedSnapshot();
      return;
    }

    if (data === "2") {
      this.selectedProviderId = this.data.providerIds[1] ?? this.selectedProviderId;
      this.invalidate();
      this.tui.requestRender();
      void this.ensureSelectedSnapshot();
    }
  }

  invalidate(): void {
    this.container.invalidate();
    this.cachedWidth = undefined;
  }

  render(width: number): string[] {
    if (this.cachedWidth !== width) {
      this.rebuild(width);
    }
    return this.container.render(width);
  }
}

const ROOT_COMPLETIONS = [
  "status",
  "status codex",
  "status zai",
  "refresh",
  "refresh codex",
  "refresh zai",
  "debug",
  "debug codex",
  "debug zai",
  "account",
  "account codex",
  "account zai",
  "account clear",
  "account clear codex",
  "account clear zai",
  "setting",
  "setting reset-time",
  "setting reset-time relative",
  "setting reset-time absolute",
  "settings",
  "settings reset-time",
  "settings reset-time relative",
  "settings reset-time absolute",
];

export function registerOpenUsageCommands(
  pi: ExtensionAPI,
  state: OpenUsageRuntimeState,
  refreshProvider: (
    providerId: SupportedProviderId,
    ctx: ExtensionCommandContext,
    options?: { force?: boolean },
  ) => Promise<void>,
): void {
  registerCommand(pi, "openusage", state, refreshProvider);
  registerCommand(pi, "usage", state, refreshProvider);
}

function registerCommand(
  pi: ExtensionAPI,
  name: string,
  state: OpenUsageRuntimeState,
  refreshProvider: (
    providerId: SupportedProviderId,
    ctx: ExtensionCommandContext,
    options?: { force?: boolean },
  ) => Promise<void>,
): void {
  pi.registerCommand(name, {
    description: "Show/refresh usage, switch accounts, and manage display settings",
    getArgumentCompletions(argumentPrefix) {
      const prefix = argumentPrefix.trim().toLowerCase();
      const items = ROOT_COMPLETIONS
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) {
        await handleStatus(pi, ctx, state, refreshProvider, undefined);
        return;
      }

      const action = tokens[0].toLowerCase();

      if (action === "status") {
        await handleStatus(pi, ctx, state, refreshProvider, tokens[1]);
        return;
      }

      if (action === "refresh") {
        await handleRefresh(ctx, tokens[1], refreshProvider);
        return;
      }

      if (action === "debug") {
        await handleDebug(ctx, state, tokens[1]);
        return;
      }

      if (action === "account") {
        await handleAccount(pi, state, ctx, refreshProvider, tokens);
        return;
      }

      if (action === "setting" || action === "settings") {
        await handleSettings(pi, state, ctx, tokens);
        return;
      }

      ctx.ui.notify(
        "Usage: /openusage [status|refresh|debug|account|setting reset-time <relative|absolute>]",
        "warning",
      );
    },
  });
}

async function handleStatus(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  state: OpenUsageRuntimeState,
  refreshProvider: (
    providerId: SupportedProviderId,
    ctx: ExtensionCommandContext,
    options?: { force?: boolean },
  ) => Promise<void>,
  providerArg: string | undefined,
): Promise<void> {
  const providerId = resolveProviderArgument(providerArg, ctx);
  if (!providerId) {
    ctx.ui.notify("No supported provider selected", "warning");
    return;
  }

  const snapshot = state.snapshots.get(providerId);
  if (!snapshot && !ctx.hasUI) {
    ctx.ui.notify(`No cached usage for ${providerId}. Run /openusage refresh`, "info");
    return;
  }

  const content = snapshot ? formatSnapshotSummary(snapshot, {
    resetTimeFormat: state.persisted.resetTimeFormat,
  }) : `No cached usage for ${providerId}. Run /openusage refresh`;

  if (!ctx.hasUI) {
    pi.sendMessage({ customType: "openusage", content, display: true }, { triggerTurn: false });
    return;
  }

  const accountsByProvider: CliproxyAccountsByProvider = await listCliproxyAccounts(ctx).catch(() => ({}));
  const providerIds: SupportedProviderId[] = [...SUPPORTED_PROVIDER_IDS];
  const activeProviderId = resolveSupportedProviderId(ctx.model?.provider, ctx.model?.id);

  await ctx.ui.custom<void>((tui, theme, _kb, done) => {
    return new OpenUsageView(
      tui,
      theme,
      {
        state,
        accountsByProvider,
        providerIds,
        initialProviderId: providerId,
        activeProviderId,
        activeModelLabel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        refreshProvider: (nextProviderId, options) => refreshProvider(nextProviderId, ctx, options),
        persistState: () => persistState(pi, state),
      },
      done,
    );
  });
}

async function handleRefresh(
  ctx: ExtensionCommandContext,
  providerArg: string | undefined,
  refreshProvider: (
    providerId: SupportedProviderId,
    ctx: ExtensionCommandContext,
    options?: { force?: boolean },
  ) => Promise<void>,
): Promise<void> {
  const providerId = resolveProviderArgument(providerArg, ctx);
  if (!providerId) {
    ctx.ui.notify("No supported provider selected", "warning");
    return;
  }

  try {
    await refreshProvider(providerId, ctx, { force: true });
    ctx.ui.notify(`Refreshed ${providerId} usage`, "info");
  } catch (error) {
    ctx.ui.notify(`OpenUsage ${providerId}: ${formatError(error)}`, "warning");
  }
}

async function handleDebug(
  ctx: ExtensionCommandContext,
  state: OpenUsageRuntimeState,
  providerArg: string | undefined,
): Promise<void> {
  const providerId = resolveProviderArgument(providerArg, ctx);
  const snapshot = providerId ? state.snapshots.get(providerId) : undefined;
  const cliproxyState = await resolveCliproxyState(ctx);
  const cliproxyAccounts: CliproxyAccountsByProvider = await listCliproxyAccounts(ctx).catch(
    () => ({}),
  );
  const lines = [
    `Model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"}`,
    `Active provider: ${providerId ?? "none"}`,
    `Host auth codex: ${ctx.modelRegistry.authStorage.hasAuth("openai-codex")}`,
    `Host auth zai: ${ctx.modelRegistry.authStorage.hasAuth("zai")}`,
    `Host auth zai-coding-plan: ${ctx.modelRegistry.authStorage.hasAuth("zai-coding-plan")}`,
    `Host auth cliproxyapi: ${ctx.modelRegistry.authStorage.hasAuth("cliproxyapi")}`,
    `Cliproxy: ${cliproxyState.label}${cliproxyState.baseUrl ? ` ${cliproxyState.baseUrl}` : ""}${cliproxyState.error ? ` (${cliproxyState.error})` : ""}`,
    `Reset time format: ${state.persisted.resetTimeFormat}`,
    `Selected codex account: ${state.persisted.selectedAccounts.codex ?? "host"}`,
    `Selected google account: ${state.persisted.selectedAccounts.google ?? "host"}`,
    `Selected zai account: ${state.persisted.selectedAccounts.zai ?? "host"}`,
    `Cliproxy codex accounts: ${(cliproxyAccounts.codex ?? []).length}`,
    `Cliproxy google accounts: ${(cliproxyAccounts.google ?? []).length}`,
    `Cliproxy zai accounts: ${(cliproxyAccounts.zai ?? []).length}`,
    `Cached snapshot: ${snapshot ? snapshot.displayName : "none"}`,
  ];

  if (snapshot) {
    lines.push("---");
    lines.push(
      formatSnapshotSummary(snapshot, { resetTimeFormat: state.persisted.resetTimeFormat }),
    );
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

async function handleAccount(
  pi: ExtensionAPI,
  state: OpenUsageRuntimeState,
  ctx: ExtensionCommandContext,
  refreshProvider: (
    providerId: SupportedProviderId,
    ctx: ExtensionCommandContext,
    options?: { force?: boolean },
  ) => Promise<void>,
  tokens: string[],
): Promise<void> {
  const sub = tokens[1]?.toLowerCase();

  if (sub === "clear") {
    const providerId = resolveProviderArgument(tokens[2], ctx);
    if (!providerId) {
      ctx.ui.notify("No supported provider selected", "warning");
      return;
    }

    setSelectedAccount(state, providerId, undefined);
    persistState(pi, state);
    await handleRefresh(ctx, providerId, refreshProvider);
    return;
  }

  const providerId = resolveProviderArgument(sub, ctx);
  if (!providerId) {
    ctx.ui.notify("No supported provider selected", "warning");
    return;
  }

  const accountsByProvider = await listCliproxyAccounts(ctx);
  const accounts = accountsByProvider[providerId] ?? [];
  const hostLabel = `Host auth (${providerId})`;
  const options = [hostLabel, ...accounts.map((account) => `CLIProxyAPI: ${account.label}`)];

  if (options.length === 1) {
    ctx.ui.notify(`No cliproxy accounts available for ${providerId}`, "warning");
    return;
  }

  const choice = await ctx.ui.select(`OpenUsage account: ${providerId}`, options);
  if (!choice) {
    return;
  }

  if (choice === hostLabel) {
    setSelectedAccount(state, providerId, undefined);
  } else {
    const selected = accounts.find((account) => `CLIProxyAPI: ${account.label}` === choice);
    if (!selected) {
      ctx.ui.notify("Invalid account selection", "error");
      return;
    }
    setSelectedAccount(state, providerId, selected.value);
  }

  persistState(pi, state);
  await handleRefresh(ctx, providerId, refreshProvider);
}

async function handleSettings(
  pi: ExtensionAPI,
  state: OpenUsageRuntimeState,
  ctx: ExtensionCommandContext,
  tokens: string[],
): Promise<void> {
  const settingName = tokens[1]?.toLowerCase();

  if (!settingName) {
    ctx.ui.notify(`reset-time=${state.persisted.resetTimeFormat}`, "info");
    return;
  }

  if (settingName !== "reset-time") {
    ctx.ui.notify("Usage: /openusage setting reset-time <relative|absolute>", "warning");
    return;
  }

  const value = tokens[2]?.toLowerCase();
  if (!value) {
    ctx.ui.notify(`reset-time=${state.persisted.resetTimeFormat}`, "info");
    return;
  }

  if (value !== "relative" && value !== "absolute") {
    ctx.ui.notify("reset-time must be one of: relative, absolute", "warning");
    return;
  }

  setResetTimeFormat(state, value as ResetTimeFormat);
  persistState(pi, state);
  ctx.ui.notify(`OpenUsage setting updated: reset-time=${value}`, "info");
}

function persistState(pi: ExtensionAPI, state: OpenUsageRuntimeState): void {
  pi.appendEntry(OPENUSAGE_STATE_ENTRY, state.persisted);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveProviderArgument(
  value: string | undefined,
  ctx: ExtensionCommandContext,
): SupportedProviderId | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized && isSupportedProviderId(normalized)) {
    return normalized;
  }

  return resolveSupportedProviderId(ctx.model?.provider, ctx.model?.id);
}

function renderMetricSection(
  theme: any,
  label: string,
  metric: UsageMetric | undefined,
  width: number,
  resetTimeFormat: ResetTimeFormat,
  displayMode: OpenUsageDisplayMode,
): string[] {
  const muted = (s: string) => theme.fg("muted", s);
  const text = (s: string) => theme.fg("text", s);
  const now = Date.now();

  if (!metric) {
    return [muted(`${label}: `) + text("n/a")];
  }

  const reset = formatReset(metric.resetsAt, resetTimeFormat, now);
  const pace = getMetricPaceDetails(metric, displayMode, now);
  const paceHeader = pace.statusText
    ? `${muted(`${label} `)}${colorForPaceStatus(theme, pace.paceResult?.status, "●")} ${colorForPaceStatus(theme, pace.paceResult?.status, pace.statusText)}${pace.projectedText ? `${muted(" · ")}${text(pace.projectedText)}` : ""}`
    : muted(label);

  const primaryText = displayMode === "used"
    ? `${formatUsedPercent(metric)} used`
    : `${formatRemainingPercent(metric)} left`;
  const footerLeft = displayMode === "used"
    ? colorUsed(theme, metric, primaryText)
    : colorRemaining(theme, metric, primaryText);
  const footerRight = reset
    ? `${muted("resets ")}${text(reset)}`
    : text(`${formatUsedPercent(metric)} / ${formatRemainingPercent(metric)}`);

  const barWidth = Math.max(10, Math.min(36, width - 12));
  const bar =
    renderMetricBar(theme, metric, barWidth, displayMode, pace.elapsedPercent) +
    " " +
    theme.fg("dim", "used") +
    (displayMode === "used" ? colorUsed(theme, metric, "█") : theme.fg("dim", "█")) +
    " " +
    theme.fg("dim", "left") +
    (displayMode === "used" ? theme.fg("dim", "█") : colorRemaining(theme, metric, "█")) +
    (pace.elapsedPercent !== null ? `${muted(" pace ")}${theme.fg("accent", "▏")}` : "");

  const lines = [paceHeader, bar, composeMetricFooter(footerLeft, footerRight, width)];
  if (pace.runsOutText) {
    lines.push(theme.fg("error", pace.runsOutText));
  }
  return lines;
}

function renderMetricBar(
  theme: any,
  metric: UsageMetric,
  width: number,
  displayMode: OpenUsageDisplayMode,
  elapsedPercent: number | null,
): string {
  const safeWidth = Math.max(10, width);
  const usedRatio =
    Number.isFinite(metric.used) && Number.isFinite(metric.limit) && metric.limit > 0
      ? Math.max(0, Math.min(1, metric.used / metric.limit))
      : 0;
  const usedCols = Math.max(0, Math.min(safeWidth, Math.round(usedRatio * safeWidth)));
  const remainingCols = Math.max(0, safeWidth - usedCols);
  const chars = new Array<string>(safeWidth);
  for (let i = 0; i < safeWidth; i++) {
    const isUsed = i < usedCols;
    chars[i] = isUsed
      ? (displayMode === "used" ? colorUsed(theme, metric, "█") : theme.fg("dim", "█"))
      : (displayMode === "used" ? theme.fg("dim", "█") : colorRemaining(theme, metric, "█"));
  }

  if (elapsedPercent !== null && Number.isFinite(elapsedPercent)) {
    const markerRatio = Math.max(0, Math.min(1, elapsedPercent / 100));
    const markerIndex = Math.max(0, Math.min(safeWidth - 1, Math.round(markerRatio * (safeWidth - 1))));
    chars[markerIndex] = theme.fg("accent", "▏");
  }

  return chars.join("");
}

function colorRemaining(theme: any, metric: UsageMetric, value: string): string {
  const remaining = getRemainingPercent(metric);
  if (remaining === undefined) {
    return theme.fg("muted", value);
  }

  if (remaining <= 15) {
    return theme.fg("error", value);
  }

  if (remaining <= 35) {
    return theme.fg("warning", value);
  }

  return theme.fg("success", value);
}

function colorUsed(theme: any, metric: UsageMetric, value: string): string {
  const remaining = getRemainingPercent(metric);
  if (remaining === undefined) {
    return theme.fg("muted", value);
  }

  if (remaining <= 15) {
    return theme.fg("error", value);
  }

  if (remaining <= 35) {
    return theme.fg("warning", value);
  }

  return theme.fg("success", value);
}

function colorForPaceStatus(theme: any, status: PaceStatus | undefined, value: string): string {
  if (status === "behind") {
    return theme.fg("error", value);
  }

  if (status === "on-track") {
    return theme.fg("warning", value);
  }

  if (status === "ahead") {
    return theme.fg("success", value);
  }

  return theme.fg("muted", value);
}

function composeMetricFooter(left: string, right: string, width: number): string {
  const safeWidth = Math.max(10, width - 4);
  const rightWidth = visibleWidth(right);
  if (rightWidth >= safeWidth) {
    return truncateToWidth(right, safeWidth, "");
  }

  const gap = left && right ? 1 : 0;
  const leftBudget = Math.max(0, safeWidth - rightWidth - gap);
  const leftPart = truncateToWidth(left, leftBudget, "…");
  const leftWidth = visibleWidth(leftPart);
  const spacer = " ".repeat(Math.max(0, safeWidth - leftWidth - rightWidth));
  return `${leftPart}${spacer}${right}`;
}

function providerDisplayName(providerId: SupportedProviderId): string {
  if (providerId === "zai") {
    return "Z.ai";
  }

  if (providerId === "google") {
    return "Google";
  }

  return "Codex";
}

function formatAge(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "unknown";
  }

  const diff = Date.now() - timestamp;
  if (diff <= 0) {
    return "just now";
  }

  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  const days = Math.floor(diff / dayMs);
  const hours = Math.floor((diff % dayMs) / hourMs);
  const minutes = Math.max(1, Math.floor((diff % hourMs) / minuteMs));

  if (days > 0) {
    return `${days}d ${hours}h ago`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m ago`;
  }

  return `${minutes}m ago`;
}
