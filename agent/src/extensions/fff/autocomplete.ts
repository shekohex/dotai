import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import type { MixedItem } from "@ff-labs/fff-node";
import { MENTION_MAX_RESULTS } from "./constants.js";
import type { FffToolRuntime } from "./types.js";

// ---------------------------------------------------------------------------
// Mention autocomplete helpers
// ---------------------------------------------------------------------------

function extractAtPrefix(textBeforeCursor: string): string | null {
  const match = textBeforeCursor.match(/(?:^|[ \t])(@(?:"[^"]*|[^\s]*))$/);
  return match?.[1] ?? null;
}

function buildAtCompletionValue(path: string): string {
  return path.includes(" ") ? `@"${path}"` : `@${path}`;
}

function createFffMentionProvider(
  getItems: (query: string, signal: AbortSignal) => Promise<AutocompleteItem[]>,
): AutocompleteProvider {
  return {
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const currentLine = lines[cursorLine] ?? "";
      const prefix = extractAtPrefix(currentLine.slice(0, cursorCol));
      if (prefix === null || options.signal.aborted) return null;

      const query = prefix.startsWith('@"') ? prefix.slice(2) : prefix.slice(1);
      const items = await getItems(query, options.signal);
      return options.signal.aborted || items.length === 0 ? null : { items, prefix };
    },
    applyCompletion(_lines, cursorLine, cursorCol, item, prefix) {
      const currentLine = _lines[cursorLine] ?? "";
      const before = currentLine.slice(0, cursorCol - prefix.length);
      const after = currentLine.slice(cursorCol);
      const newLine = before + item.value + after;
      const newCursorCol = cursorCol - prefix.length + item.value.length;
      return {
        lines: [..._lines.slice(0, cursorLine), newLine, ..._lines.slice(cursorLine + 1)],
        cursorLine,
        cursorCol: newCursorCol,
      };
    },
  };
}

async function getMentionItems(
  runtime: FffToolRuntime,
  query: string,
  signal: AbortSignal,
): Promise<AutocompleteItem[]> {
  if (signal.aborted) return [];
  const finder = await runtime.ensureFinder(runtime.getActiveCwd());
  if (signal.aborted) return [];

  const result = finder.mixedSearch(query, { pageSize: MENTION_MAX_RESULTS });
  if (!result.ok) return [];

  return result.value.items.slice(0, MENTION_MAX_RESULTS).map((mixed: MixedItem) => {
    if (mixed.type === "directory") {
      return {
        value: buildAtCompletionValue(mixed.item.relativePath),
        label: mixed.item.dirName,
        description: mixed.item.relativePath,
      };
    }
    return {
      value: buildAtCompletionValue(mixed.item.relativePath),
      label: mixed.item.fileName,
      description: mixed.item.relativePath,
    };
  });
}

export function registerAutocompleteProvider(
  runtime: FffToolRuntime,
  ctx: {
    ui: {
      addAutocompleteProvider: (
        factory: (current: AutocompleteProvider) => AutocompleteProvider,
      ) => void;
    };
  },
): void {
  ctx.ui.addAutocompleteProvider((current) => {
    const mentionProvider = createFffMentionProvider((query, signal) =>
      getMentionItems(runtime, query, signal),
    );

    return {
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        try {
          const mentionResult = await mentionProvider.getSuggestions(
            lines,
            cursorLine,
            cursorCol,
            options,
          );
          if (mentionResult !== null) return mentionResult;
        } catch {
          // Delegate when FFF lookup is unavailable.
        }

        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      },
      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      },
      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
      },
    };
  });
}
