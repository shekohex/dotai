import type { AutocompleteItem } from "@mariozechner/pi-tui";

type ModeAutocompleteEntry = {
  modeName: string;
  description?: string;
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

  return tokens.length === 1 && !endsWithSpace ? getModeRootCompletions(command, modes) : null;
}
