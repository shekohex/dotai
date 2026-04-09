import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { listCliproxyAccounts, resolveCliproxyState } from "./cliproxy.js";
import { resolveSupportedProviderId } from "./model-map.js";
import { formatSnapshotSummary } from "./status.js";
import { setResetTimeFormat, setSelectedAccount } from "./state.js";
import type {
  CliproxyAccountsByProvider,
  OpenUsageRuntimeState,
  ResetTimeFormat,
  SupportedProviderId,
} from "./types.js";
import {
  isSupportedProviderId,
  OPENUSAGE_STATE_ENTRY,
} from "./types.js";
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
  registerCommand(pi, "opensusage", state, refreshProvider);
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
        await handleStatus(ctx, state, undefined);
        return;
      }

      const action = tokens[0].toLowerCase();

      if (action === "status") {
        await handleStatus(ctx, state, tokens[1]);
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
  ctx: ExtensionCommandContext,
  state: OpenUsageRuntimeState,
  providerArg: string | undefined,
): Promise<void> {
  const providerId = resolveProviderArgument(providerArg, ctx);
  if (!providerId) {
    ctx.ui.notify("No supported provider selected", "warning");
    return;
  }

  const snapshot = state.snapshots.get(providerId);
  if (!snapshot) {
    ctx.ui.notify(`No cached usage for ${providerId}. Run /openusage refresh`, "info");
    return;
  }

  ctx.ui.notify(
    formatSnapshotSummary(snapshot, { resetTimeFormat: state.persisted.resetTimeFormat }),
    "info",
  );
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
    `Selected zai account: ${state.persisted.selectedAccounts.zai ?? "host"}`,
    `Cliproxy codex accounts: ${(cliproxyAccounts.codex ?? []).length}`,
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
