import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { fuzzyFilter, type AutocompleteItem } from "@mariozechner/pi-tui";
import type { ModeSpec } from "../../mode-utils.js";
import { loadAvailableModes } from "../available-modes.js";
import type { SessionModel } from "../session-launch-utils.js";
import type { HandoffRuntimeState } from "./shared.js";

type HandoffFlagName = "-mode" | "-model";

type HandoffAutocompleteContext = {
  kind: "flag" | "mode" | "model" | "goal" | "none";
  prefixBase: string;
  query: string;
  usedFlags: Set<HandoffFlagName>;
};

const HANDOFF_FLAG_OPTIONS: Array<{ name: HandoffFlagName; description: string }> = [
  { name: "-mode", description: "Apply a saved mode to the new session" },
  { name: "-model", description: "Override the new session model (provider/modelId)" },
];

function describeModeSpec(spec: ModeSpec | undefined): string | undefined {
  if (!spec) {
    return undefined;
  }

  const parts: string[] = [];
  if (
    spec.provider !== undefined &&
    spec.provider.length > 0 &&
    spec.modelId !== undefined &&
    spec.modelId.length > 0
  ) {
    parts.push(`${spec.provider}/${spec.modelId}`);
  }
  if (spec.thinkingLevel !== undefined) {
    parts.push(`thinking:${spec.thinkingLevel}`);
  }

  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function getAvailableModelsForAutocomplete(ctx: ExtensionContext | undefined): SessionModel[] {
  return (ctx?.modelRegistry.getAvailable() ?? []).filter(
    (model): model is SessionModel =>
      model !== undefined &&
      model !== null &&
      typeof model === "object" &&
      typeof model.provider === "string" &&
      typeof model.id === "string",
  );
}

function filterAutocompleteItems(
  items: AutocompleteItem[],
  query: string,
): AutocompleteItem[] | null {
  if (items.length === 0) {
    return null;
  }

  if (!query) {
    return items;
  }

  const filtered = fuzzyFilter(
    items,
    query,
    (item) => `${item.label} ${item.value} ${item.description ?? ""}`,
  );
  return filtered.length > 0 ? filtered : null;
}

function consumeWhitespace(value: string, index: number): number {
  let cursor = index;
  while (cursor < value.length && /\s/.test(value[cursor] ?? "")) {
    cursor += 1;
  }
  return cursor;
}

function readToken(value: string, index: number): { start: number; end: number; token: string } {
  const start = index;
  let end = index;
  while (end < value.length && !/\s/.test(value[end] ?? "")) {
    end += 1;
  }
  return { start, end, token: value.slice(start, end) };
}

function buildFlagContext(
  kind: HandoffAutocompleteContext["kind"],
  prefixBase: string,
  query: string,
  usedFlags: Set<HandoffFlagName>,
): HandoffAutocompleteContext {
  return { kind, prefixBase, query, usedFlags };
}

function parseMissingFlagValue(
  argumentPrefix: string,
  flag: HandoffFlagName,
  flagEnd: number,
  usedFlags: Set<HandoffFlagName>,
): { context?: HandoffAutocompleteContext; nextIndex: number } {
  const valueStart = consumeWhitespace(argumentPrefix, flagEnd);
  if (valueStart >= argumentPrefix.length) {
    return {
      context: buildFlagContext(
        flag === "-mode" ? "mode" : "model",
        argumentPrefix.slice(0, valueStart),
        "",
        usedFlags,
      ),
      nextIndex: valueStart,
    };
  }

  const valueToken = readToken(argumentPrefix, valueStart);
  if (valueToken.end >= argumentPrefix.length) {
    return {
      context: buildFlagContext(
        flag === "-mode" ? "mode" : "model",
        argumentPrefix.slice(0, valueToken.start),
        valueToken.token,
        usedFlags,
      ),
      nextIndex: valueToken.end,
    };
  }

  return finalizeParsedFlag(argumentPrefix, flag, valueToken.end, usedFlags);
}

function finalizeParsedFlag(
  argumentPrefix: string,
  flag: HandoffFlagName,
  valueEnd: number,
  usedFlags: Set<HandoffFlagName>,
): { context?: HandoffAutocompleteContext; nextIndex: number } {
  usedFlags.add(flag);
  const nextIndex = consumeWhitespace(argumentPrefix, valueEnd);
  if (nextIndex >= argumentPrefix.length) {
    return {
      context: buildFlagContext("flag", argumentPrefix, "", usedFlags),
      nextIndex,
    };
  }
  if (argumentPrefix[nextIndex] !== "-") {
    return {
      context: buildFlagContext("goal", argumentPrefix.slice(0, nextIndex), "", usedFlags),
      nextIndex,
    };
  }
  return { nextIndex };
}

function parseHandoffAutocompleteContext(argumentPrefix: string): HandoffAutocompleteContext {
  const usedFlags = new Set<HandoffFlagName>();
  let index = 0;
  while (index < argumentPrefix.length) {
    index = consumeWhitespace(argumentPrefix, index);
    if (index >= argumentPrefix.length) {
      return { kind: "flag", prefixBase: argumentPrefix, query: "", usedFlags };
    }
    if (argumentPrefix[index] !== "-") {
      return { kind: "goal", prefixBase: argumentPrefix.slice(0, index), query: "", usedFlags };
    }

    const flag = readToken(argumentPrefix, index);
    const parsed = parseAutocompleteFlag(
      argumentPrefix,
      flag.start,
      flag.end,
      flag.token,
      usedFlags,
    );
    if (parsed.context) {
      return parsed.context;
    }
    index = parsed.nextIndex;
  }

  return { kind: "flag", prefixBase: argumentPrefix, query: "", usedFlags };
}

function parseAutocompleteFlag(
  argumentPrefix: string,
  flagStart: number,
  flagEnd: number,
  flagToken: string,
  usedFlags: Set<HandoffFlagName>,
): { context?: HandoffAutocompleteContext; nextIndex: number } {
  const flag = flagToken === "-mode" || flagToken === "-model" ? flagToken : undefined;
  if (!flag) {
    return {
      context: buildFlagContext(
        flagEnd >= argumentPrefix.length ? "flag" : "none",
        argumentPrefix.slice(0, flagStart),
        flagToken,
        usedFlags,
      ),
      nextIndex: flagEnd,
    };
  }
  if (flagEnd >= argumentPrefix.length) {
    return {
      context: buildFlagContext("flag", argumentPrefix.slice(0, flagStart), flagToken, usedFlags),
      nextIndex: flagEnd,
    };
  }

  return parseMissingFlagValue(argumentPrefix, flag, flagEnd, usedFlags);
}

function getHandoffFlagCompletions(
  prefixBase: string,
  query: string,
  usedFlags: Set<HandoffFlagName>,
): AutocompleteItem[] | null {
  const items = HANDOFF_FLAG_OPTIONS.filter((flag) => !usedFlags.has(flag.name)).map((flag) => ({
    value: `${prefixBase}${flag.name} `,
    label: flag.name,
    description: flag.description,
  }));

  return filterAutocompleteItems(items, query);
}

async function getHandoffModeCompletions(
  prefixBase: string,
  query: string,
  ctx: ExtensionContext | undefined,
): Promise<AutocompleteItem[] | null> {
  if (!ctx) {
    return null;
  }

  const items = (await loadAvailableModes(ctx.cwd)).map(({ name, spec }) => ({
    value: `${prefixBase}${name}`,
    label: name,
    description: describeModeSpec(spec),
  }));

  return filterAutocompleteItems(items, query);
}

function getHandoffModelCompletions(
  prefixBase: string,
  query: string,
  ctx: ExtensionContext | undefined,
): AutocompleteItem[] | null {
  const models = getAvailableModelsForAutocomplete(ctx);
  if (models.length === 0) {
    return null;
  }

  const items = models.map((model) => ({
    value: `${prefixBase}${model.provider}/${model.id}`,
    label: model.id,
    description: model.provider,
  }));

  return filterAutocompleteItems(items, query);
}

function getHandoffArgumentCompletions(
  argumentPrefix: string,
  state: HandoffRuntimeState,
): Promise<AutocompleteItem[] | null> | AutocompleteItem[] | null {
  const parsed = parseHandoffAutocompleteContext(argumentPrefix);
  if (parsed.kind === "goal" || parsed.kind === "none") {
    return null;
  }

  if (parsed.kind === "flag") {
    return getHandoffFlagCompletions(parsed.prefixBase, parsed.query, parsed.usedFlags);
  }

  if (parsed.kind === "mode") {
    return getHandoffModeCompletions(parsed.prefixBase, parsed.query, state.ctx);
  }

  return getHandoffModelCompletions(parsed.prefixBase, parsed.query, state.ctx);
}

export { getHandoffArgumentCompletions };
