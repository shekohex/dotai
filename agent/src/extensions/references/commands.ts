import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { deleteReferenceConfigEntry, saveReferenceConfigEntry } from "./config.js";
import { renderReferencesSummary, showReferencesDashboard } from "./dashboard.js";
import {
  refreshLoadedReference,
  refreshLoadedReferences,
  reloadReferenceConfig,
  type ReferenceRuntimeState,
} from "./runtime.js";
import { showReferenceWizard } from "./wizard.js";

const SUBCOMMANDS: AutocompleteItem[] = [
  { value: "list", label: "list", description: "List configured references" },
  { value: "refresh", label: "refresh", description: "Refresh all configured references" },
];

export function getReferencesArgumentCompletions(prefix: string): AutocompleteItem[] {
  const normalized = prefix.trim().toLowerCase();
  if (normalized.length === 0) {
    return SUBCOMMANDS;
  }
  return SUBCOMMANDS.filter((item) => item.value.startsWith(normalized));
}

export async function handleReferencesCommand(
  pi: Pick<ExtensionAPI, "exec">,
  state: ReferenceRuntimeState,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  await reloadReferenceConfig(ctx.cwd, state);
  const subcommand = args.trim().toLowerCase();
  if (subcommand === "list") {
    ctx.ui.notify(renderReferencesSummary(state), "info");
    return;
  }
  if (subcommand === "refresh") {
    await refreshLoadedReferences(pi, state);
    ctx.ui.notify("References refreshed", "info");
    return;
  }

  if (!ctx.hasUI) {
    ctx.ui.notify(renderReferencesSummary(state), "info");
    return;
  }

  let keepOpen = true;
  while (keepOpen) {
    const action = await showReferencesDashboard(ctx, state, {
      refresh: (alias) => refreshLoadedReference(pi, state, alias),
      refreshAll: async () => {
        const results = await Promise.allSettled(
          state.references.map((reference) => refreshLoadedReference(pi, state, reference.alias)),
        );
        return results.flatMap((result) =>
          result.status === "fulfilled" && result.value !== undefined ? [result.value] : [],
        );
      },
      onError: (message) => {
        ctx.ui.notify(`Reference refresh failed: ${message}`, "error");
      },
    });
    if (action === null) {
      keepOpen = false;
      continue;
    }
    if (action.type === "delete") {
      await deleteReference(ctx, state, action.alias);
      continue;
    }
    if (action.type === "add") {
      await addReference(pi, ctx, state);
      continue;
    }
    if (action.type === "edit") {
      await editReference(pi, ctx, state, action.alias);
    }
  }
}

async function addReference(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: ExtensionCommandContext,
  state: ReferenceRuntimeState,
): Promise<void> {
  const form = await showReferenceWizard(ctx, {
    cwd: ctx.cwd,
    existingAliases: state.references.map((reference) => reference.alias),
  });
  if (form === undefined) {
    return;
  }
  await saveReferenceConfigEntry(form.sourceFile, form.alias, form.entry);
  await reloadReferenceConfig(ctx.cwd, state);
  if (form.refreshNow) {
    await refreshLoadedReference(pi, state, form.alias);
  }
}

async function editReference(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: ExtensionCommandContext,
  state: ReferenceRuntimeState,
  alias: string,
): Promise<void> {
  const existing = state.byAlias.get(alias);
  if (existing === undefined) {
    return;
  }
  const form = await showReferenceWizard(ctx, {
    cwd: ctx.cwd,
    existing,
    existingAliases: state.references.map((reference) => reference.alias),
  });
  if (form === undefined) {
    return;
  }
  await saveReferenceConfigEntry(form.sourceFile, form.alias, form.entry);
  if (form.alias !== existing.alias || form.sourceFile !== existing.sourceFile) {
    await deleteReferenceConfigEntry(existing.sourceFile, existing.alias);
  }
  await reloadReferenceConfig(ctx.cwd, state);
  if (form.refreshNow) {
    await refreshLoadedReference(pi, state, form.alias);
  }
}

async function deleteReference(
  ctx: ExtensionCommandContext,
  state: ReferenceRuntimeState,
  alias: string,
): Promise<void> {
  const reference = state.byAlias.get(alias);
  if (reference === undefined) {
    return;
  }
  const confirmed = await ctx.ui.confirm(
    "Delete reference?",
    `Remove @${alias} from ${reference.sourceFile}?`,
  );
  if (!confirmed) {
    return;
  }
  await deleteReferenceConfigEntry(reference.sourceFile, alias);
  await reloadReferenceConfig(ctx.cwd, state);
}
