import { fuzzyFilter, type AutocompleteItem } from "@earendil-works/pi-tui";

type ModeAutocompleteEntry = {
  modeName: string;
  description?: string;
};

type ModelAutocompleteEntry = {
  provider: string;
  modelId: string;
};

function filterAutocompleteItems(
  items: AutocompleteItem[],
  query: string,
): AutocompleteItem[] | null {
  const normalizedQuery = query.trim().toLowerCase();
  const filtered =
    normalizedQuery.length === 0
      ? items
      : items.filter((item) => {
          const haystack = [item.value, item.label, item.description]
            .filter((value): value is string => typeof value === "string")
            .join(" ")
            .toLowerCase();
          return haystack.includes(normalizedQuery);
        });

  return filtered.length > 0 ? filtered : null;
}

function getModeSelectionItems(modes: ModeAutocompleteEntry[]): AutocompleteItem[] {
  return modes.map((mode) => ({
    value: mode.modeName,
    label: mode.modeName,
    description: mode.description,
  }));
}

function getModeRootCompletions(
  query: string,
  modes: ModeAutocompleteEntry[],
): AutocompleteItem[] | null {
  return filterAutocompleteItems(
    [
      ...getModeSelectionItems(modes),
      {
        value: "store ",
        label: "store",
        description: "Save current selection as a mode",
      },
      {
        value: "reload",
        label: "reload",
        description: "Reload modes from config",
      },
    ],
    query,
  );
}

function getOverrideFlagCompletion(modeName: string, query: string): AutocompleteItem[] | null {
  return filterAutocompleteItems(
    [
      {
        value: `${modeName} --override `,
        label: "--override",
        description: "Use session-only model override for this mode",
      },
    ],
    query,
  );
}

function getModelOverrideCompletions(
  modeName: string,
  query: string,
  models: ModelAutocompleteEntry[],
): AutocompleteItem[] | null {
  if (models.length === 0) return null;

  const filtered = fuzzyFilter(models, query, (model) => `${model.modelId} ${model.provider}`);
  if (filtered.length === 0) return null;

  return filtered.map((model) => ({
    value: `${modeName} --override ${model.provider}/${model.modelId}`,
    label: model.modelId,
    description: model.provider,
  }));
}

function getModeStoreCompletions(
  query: string,
  modes: ModeAutocompleteEntry[],
): AutocompleteItem[] | null {
  const items = modes.map((mode) => ({
    value: `store ${mode.modeName}`,
    label: mode.modeName,
    description: ["Overwrite existing mode", mode.description]
      .filter((value): value is string => typeof value === "string")
      .join(" · "),
  }));

  return filterAutocompleteItems(items, query);
}

export function getModeArgumentCompletions(
  argumentPrefix: string,
  modes: ModeAutocompleteEntry[],
  models: ModelAutocompleteEntry[] = [],
): AutocompleteItem[] | null {
  const normalizedPrefix = argumentPrefix.replace(/^\s+/, "");
  if (!normalizedPrefix) {
    return getModeRootCompletions("", modes);
  }

  const tokens = normalizedPrefix.split(/\s+/).filter(Boolean);
  const endsWithSpace = /\s$/.test(normalizedPrefix);
  const command = tokens[0];
  if (!command) {
    return getModeRootCompletions("", modes);
  }

  if (command === "store") {
    if (tokens.length === 1 && !endsWithSpace) {
      return getModeRootCompletions(command, modes);
    }

    if (tokens.length > 2) {
      return null;
    }

    return getModeStoreCompletions(tokens[1] ?? "", modes);
  }

  if (command === "reload") {
    return tokens.length === 1 && !endsWithSpace ? getModeRootCompletions(command, modes) : null;
  }

  if (tokens.length === 1) {
    if (endsWithSpace) {
      return getOverrideFlagCompletion(command, "");
    }
    return getModeRootCompletions(command, modes);
  }

  if (tokens[1] === "--override") {
    if (tokens.length === 2 && !endsWithSpace) {
      return getOverrideFlagCompletion(command, tokens[1]);
    }
    if (tokens.length > 3) {
      return null;
    }
    return getModelOverrideCompletions(command, tokens[2] ?? "", models);
  }

  return tokens.length === 2 && !endsWithSpace
    ? getOverrideFlagCompletion(command, tokens[1])
    : null;
}
