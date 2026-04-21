import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { listCliproxyAccounts } from "./cliproxy.js";
import { handleDebug } from "./command-debug.js";
import { resolveSupportedProviderId } from "./model-map.js";
import { formatSnapshotSummary } from "./status.js";
import { setResetTimeFormat, setSelectedAccount } from "./state.js";
import type {
  CliproxyAccount,
  CliproxyAccountsByProvider,
  OpenUsageRuntimeState,
  SupportedProviderId,
} from "./types.js";
import { isSupportedProviderId, OPENUSAGE_STATE_ENTRY } from "./types.js";
import { OpenUsageView } from "./view.js";

type RefreshProvider = (
  providerId: SupportedProviderId,
  ctx: ExtensionCommandContext,
  options?: { force?: boolean },
) => Promise<void>;

function createOpenUsageCommandHandler(
  pi: ExtensionAPI,
  state: OpenUsageRuntimeState,
  refreshProvider: RefreshProvider,
): (args: string, ctx: ExtensionCommandContext) => Promise<void> {
  return async (args, ctx) => {
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const action = tokens[0]?.toLowerCase();

    if (action === undefined) {
      await handleStatus(pi, ctx, state, refreshProvider);
      return;
    }
    if (action === "status") {
      await handleStatus(pi, ctx, state, refreshProvider, tokens[1]);
      return;
    }
    if (action === "refresh") {
      await handleRefresh(ctx, tokens[1], refreshProvider);
      return;
    }
    if (action === "debug") {
      await handleDebug(ctx, state, resolveProviderArgument(tokens[1], ctx));
      return;
    }
    if (action === "account") {
      await handleAccount(pi, state, ctx, refreshProvider, tokens);
      return;
    }
    if (action === "setting" || action === "settings") {
      handleSettings(pi, state, ctx, tokens);
      return;
    }

    ctx.ui.notify(
      "Usage: /openusage [status|refresh|debug|account|setting reset-time <relative|absolute>]",
      "warning",
    );
  };
}

async function handleStatus(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  state: OpenUsageRuntimeState,
  refreshProvider: RefreshProvider,
  providerArg?: string,
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

  const content = snapshot
    ? formatSnapshotSummary(snapshot, {
        resetTimeFormat: state.persisted.resetTimeFormat,
      })
    : `No cached usage for ${providerId}. Run /openusage refresh`;

  if (!ctx.hasUI) {
    pi.sendMessage({ customType: "openusage", content, display: true }, { triggerTurn: false });
    return;
  }

  await showOpenUsageView(pi, ctx, state, refreshProvider, providerId);
}

async function showOpenUsageView(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  state: OpenUsageRuntimeState,
  refreshProvider: RefreshProvider,
  providerId: SupportedProviderId,
): Promise<void> {
  const accountsByProvider: CliproxyAccountsByProvider = await listCliproxyAccounts(ctx).catch(
    () => ({}),
  );
  const providerIds: SupportedProviderId[] = ["codex", "google", "zai"];
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
        persistState: () => {
          persistState(pi, state);
        },
      },
      done,
    );
  });
}

async function handleRefresh(
  ctx: ExtensionCommandContext,
  providerArg: string | undefined,
  refreshProvider: RefreshProvider,
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

async function handleAccount(
  pi: ExtensionAPI,
  state: OpenUsageRuntimeState,
  ctx: ExtensionCommandContext,
  refreshProvider: RefreshProvider,
  tokens: string[],
): Promise<void> {
  const sub = tokens[1]?.toLowerCase();

  if (sub === "clear") {
    await handleClearAccount(pi, state, ctx, refreshProvider, tokens[2]);
    return;
  }

  await handleSelectAccount(pi, state, ctx, refreshProvider, sub);
}

async function handleClearAccount(
  pi: ExtensionAPI,
  state: OpenUsageRuntimeState,
  ctx: ExtensionCommandContext,
  refreshProvider: RefreshProvider,
  providerArg: string | undefined,
): Promise<void> {
  const providerId = resolveProviderArgument(providerArg, ctx);
  if (!providerId) {
    ctx.ui.notify("No supported provider selected", "warning");
    return;
  }

  setSelectedAccount(state, providerId, undefined);
  persistState(pi, state);
  await handleRefresh(ctx, providerId, refreshProvider);
}

async function handleSelectAccount(
  pi: ExtensionAPI,
  state: OpenUsageRuntimeState,
  ctx: ExtensionCommandContext,
  refreshProvider: RefreshProvider,
  providerArg: string | undefined,
): Promise<void> {
  const providerId = resolveProviderArgument(providerArg, ctx);
  if (!providerId) {
    ctx.ui.notify("No supported provider selected", "warning");
    return;
  }
  const accounts = (await listCliproxyAccounts(ctx))[providerId] ?? [];
  const hostLabel = `Host auth (${providerId})`;
  const options = [hostLabel, ...accounts.map((account) => `CLIProxyAPI: ${account.label}`)];

  if (options.length === 1) {
    ctx.ui.notify(`No cliproxy accounts available for ${providerId}`, "warning");
    return;
  }

  const choice = await ctx.ui.select(`OpenUsage account: ${providerId}`, options);
  if (choice === undefined || choice.length === 0) {
    return;
  }
  if (!setSelectedAccountFromChoice(state, providerId, choice, hostLabel, accounts)) {
    ctx.ui.notify("Invalid account selection", "error");
    return;
  }

  persistState(pi, state);
  await handleRefresh(ctx, providerId, refreshProvider);
}

function handleSettings(
  pi: ExtensionAPI,
  state: OpenUsageRuntimeState,
  ctx: ExtensionCommandContext,
  tokens: string[],
): void {
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

  setResetTimeFormat(state, value);
  persistState(pi, state);
  ctx.ui.notify(`OpenUsage setting updated: reset-time=${value}`, "info");
}

function setSelectedAccountFromChoice(
  state: OpenUsageRuntimeState,
  providerId: SupportedProviderId,
  choice: string,
  hostLabel: string,
  accounts: CliproxyAccount[],
): boolean {
  if (choice === hostLabel) {
    setSelectedAccount(state, providerId, undefined);
    return true;
  }
  const selected = accounts.find((account) => `CLIProxyAPI: ${account.label}` === choice);
  if (!selected) {
    return false;
  }
  setSelectedAccount(state, providerId, selected.value);
  return true;
}

function resolveProviderArgument(
  value: string | undefined,
  ctx: ExtensionCommandContext,
): SupportedProviderId | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized !== undefined && normalized.length > 0 && isSupportedProviderId(normalized)) {
    return normalized;
  }
  return resolveSupportedProviderId(ctx.model?.provider, ctx.model?.id);
}

function persistState(pi: ExtensionAPI, state: OpenUsageRuntimeState): void {
  pi.appendEntry(OPENUSAGE_STATE_ENTRY, state.persisted);
}
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { createOpenUsageCommandHandler };
