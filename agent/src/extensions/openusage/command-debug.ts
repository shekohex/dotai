import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { listCliproxyAccounts, resolveCliproxyState } from "./cliproxy.js";
import { formatSnapshotSummary } from "./status.js";
import type {
  CliproxyAccountsByProvider,
  OpenUsageRuntimeState,
  SupportedProviderId,
} from "./types.js";

async function handleDebug(
  ctx: ExtensionCommandContext,
  state: OpenUsageRuntimeState,
  providerId: SupportedProviderId | undefined,
): Promise<void> {
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
    `Cliproxy: ${cliproxyState.label}${cliproxyState.baseUrl !== undefined && cliproxyState.baseUrl.length > 0 ? ` ${cliproxyState.baseUrl}` : ""}${cliproxyState.error !== undefined && cliproxyState.error.length > 0 ? ` (${cliproxyState.error})` : ""}`,
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

export { handleDebug };
