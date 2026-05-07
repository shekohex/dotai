import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { GsdSubcommand } from "./commands.js";

export const GsdCommandArgsSchema = Type.Object(
  {
    subcommand: Type.Optional(Type.String()),
    auto: Type.Optional(Type.Boolean()),
    phase: Type.Optional(Type.String()),
    paths: Type.Optional(Type.Array(Type.String())),
    fast: Type.Optional(Type.Boolean()),
    focus: Type.Optional(
      Type.Union([
        Type.Literal("tech"),
        Type.Literal("arch"),
        Type.Literal("quality"),
        Type.Literal("concerns"),
        Type.Literal("tech+arch"),
      ]),
    ),
    query: Type.Optional(Type.String()),
    existingMode: Type.Optional(
      Type.Union([Type.Literal("refresh"), Type.Literal("update"), Type.Literal("skip")]),
    ),
    unsupportedModeError: Type.Optional(Type.String()),
    version: Type.Optional(Type.String()),
    milestone: Type.Optional(Type.String()),
    input: Type.Optional(Type.String()),
    debugAction: Type.Optional(
      Type.Union([
        Type.Literal("start"),
        Type.Literal("list"),
        Type.Literal("status"),
        Type.Literal("continue"),
      ]),
    ),
    slug: Type.Optional(Type.String()),
    diagnose: Type.Optional(Type.Boolean()),
    description: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type GsdCommandArgs = Static<typeof GsdCommandArgsSchema>;

function parseNewProjectArgs(tokens: string[]): GsdCommandArgs {
  let auto = false;
  const parts: string[] = [];

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--auto") {
      auto = true;
      continue;
    }
    parts.push(token);
  }

  return validateParsedArgs({
    subcommand: "new-project",
    ...(auto ? { auto: true } : {}),
    ...(parts.length > 0 ? { input: normalizeFreeform(parts.join(" ")) } : {}),
  });
}

function normalizePhaseToken(token: string | undefined): string | undefined {
  if (token === undefined) {
    return undefined;
  }
  const value = token.trim();
  return value.length > 0 ? value : undefined;
}

function normalizePathToken(token: string | undefined): string[] | undefined {
  if (token === undefined) {
    return undefined;
  }
  const paths = token
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return paths.length > 0 ? paths : undefined;
}

function normalizeFreeform(token: string | undefined): string | undefined {
  if (token === undefined) {
    return undefined;
  }
  const value = token.trim();
  return value.length > 0 ? value : undefined;
}

function normalizeFastFocus(token: string | undefined): GsdCommandArgs["focus"] {
  const value = normalizeFreeform(token);
  if (
    value === "tech" ||
    value === "arch" ||
    value === "quality" ||
    value === "concerns" ||
    value === "tech+arch"
  ) {
    return value;
  }
  return undefined;
}

function validateParsedArgs(parsed: GsdCommandArgs): GsdCommandArgs {
  if (!Value.Check(GsdCommandArgsSchema, parsed)) {
    return {};
  }
  return parsed;
}

function parseDebugArgs(tokens: string[]): GsdCommandArgs {
  let diagnose = false;
  const filteredTokens = tokens.filter((token, index) => {
    if (index === 0) {
      return true;
    }
    if (token === "--diagnose") {
      diagnose = true;
      return false;
    }
    return true;
  });

  const action = filteredTokens[1];
  if (action === "list") {
    return validateParsedArgs({ subcommand: "debug", debugAction: "list", diagnose });
  }
  if (action === "status") {
    return validateParsedArgs({
      subcommand: "debug",
      debugAction: "status",
      slug: normalizeFreeform(filteredTokens.slice(2).join(" ")),
      diagnose,
    });
  }
  if (action === "continue") {
    return validateParsedArgs({
      subcommand: "debug",
      debugAction: "continue",
      slug: normalizeFreeform(filteredTokens.slice(2).join(" ")),
      diagnose,
    });
  }
  return validateParsedArgs({
    subcommand: "debug",
    debugAction: "start",
    diagnose,
    description: normalizeFreeform(filteredTokens.slice(1).join(" ")),
  });
}

type MapCodebaseParseState = {
  paths: string[] | undefined;
  fast: boolean;
  focus: GsdCommandArgs["focus"];
  query: string | undefined;
  existingMode: GsdCommandArgs["existingMode"];
  unsupportedModeError: string | undefined;
};

function isReservedMapCodebaseQueryMode(value: string): value is "status" | "diff" | "refresh" {
  return value === "status" || value === "diff" || value === "refresh";
}

function isMapCodebaseFreeformQueryEscape(value: string): boolean {
  return value === "query";
}

function buildMapCodebaseQueryConflictMessage(
  state: MapCodebaseParseState,
  conflict: "--fast" | "--focus" | "--paths" | GsdCommandArgs["existingMode"],
): string | undefined {
  if (state.query === undefined) {
    return undefined;
  }
  return `Unsupported /gsd map-codebase query mode: cannot combine --query with ${conflict}.`;
}

function parseMapCodebaseQueryToken(
  tokens: string[],
  index: number,
  state: MapCodebaseParseState,
): number {
  const token = tokens[index];
  const rawQueryTokens =
    token === "--query"
      ? tokens.slice(index + 1)
      : [token.slice("--query=".length), ...tokens.slice(index + 1)];
  const queryValue = normalizeFreeform(rawQueryTokens.join(" "));
  state.query = queryValue;
  if (state.query === undefined) {
    state.unsupportedModeError = "Unsupported /gsd map-codebase mode: --query requires a value.";
    return tokens.length;
  }

  const firstToken = normalizeFreeform(rawQueryTokens[0])?.toLowerCase();
  if (firstToken !== undefined && isMapCodebaseFreeformQueryEscape(firstToken)) {
    const freeformQuery = normalizeFreeform(rawQueryTokens.slice(1).join(" "));
    if (freeformQuery === undefined) {
      state.query = undefined;
      state.unsupportedModeError =
        "Unsupported /gsd map-codebase query mode: `--query query` requires a search term.";
    } else {
      state.query = freeformQuery;
    }
    return tokens.length;
  }

  if (firstToken !== undefined && isReservedMapCodebaseQueryMode(firstToken)) {
    const trailingTokens = rawQueryTokens.slice(1).filter((value) => value.trim().length > 0);
    if (trailingTokens.length > 0) {
      state.query = undefined;
      state.unsupportedModeError = `Unsupported /gsd map-codebase query mode: \
reserved query \`${firstToken}\` does not accept trailing arguments (${trailingTokens.join(" ")}).`;
    } else {
      state.query = firstToken;
    }
  }
  return tokens.length;
}

function parseMapCodebaseFocusToken(
  tokens: string[],
  index: number,
  state: MapCodebaseParseState,
): number {
  const token = tokens[index];
  const rawFocus =
    token === "--focus"
      ? normalizeFreeform(tokens[index + 1])
      : normalizeFreeform(token.slice("--focus=".length));
  if (rawFocus === undefined) {
    state.unsupportedModeError = "Unsupported /gsd map-codebase mode: --focus requires a value.";
    return index + 1;
  }
  state.focus = normalizeFastFocus(rawFocus);
  if (state.focus === undefined) {
    state.unsupportedModeError = `Unsupported /gsd map-codebase mode: --focus ${rawFocus}.`;
  }
  return token === "--focus" ? index + 2 : index + 1;
}

function parseMapCodebasePathsToken(
  tokens: string[],
  index: number,
  state: MapCodebaseParseState,
): number {
  const token = tokens[index];
  const rawPaths =
    token === "--paths"
      ? normalizeFreeform(tokens[index + 1])
      : normalizeFreeform(token.slice("--paths=".length));
  if (rawPaths === undefined) {
    state.unsupportedModeError =
      "Unsupported /gsd map-codebase mode: --paths requires at least one repo-relative path.";
    return index + 1;
  }
  state.paths = normalizePathToken(rawPaths);
  if (state.paths === undefined) {
    state.unsupportedModeError =
      "Unsupported /gsd map-codebase mode: --paths requires at least one repo-relative path.";
  }
  return token === "--paths" ? index + 2 : index + 1;
}

function parseMapCodebaseArgs(tokens: string[]): GsdCommandArgs {
  const state: MapCodebaseParseState = {
    paths: undefined,
    fast: false,
    focus: undefined,
    query: undefined,
    existingMode: undefined,
    unsupportedModeError: undefined,
  };

  for (let index = 1; index < tokens.length; ) {
    const token = tokens[index];
    if (token === "--fast") {
      const conflict = buildMapCodebaseQueryConflictMessage(state, "--fast");
      if (conflict !== undefined) {
        state.unsupportedModeError = conflict;
        break;
      }
      state.fast = true;
      index += 1;
      continue;
    }
    if (token === "--focus" || token.startsWith("--focus=")) {
      const conflict = buildMapCodebaseQueryConflictMessage(state, "--focus");
      if (conflict !== undefined) {
        state.unsupportedModeError = conflict;
        break;
      }
      index = parseMapCodebaseFocusToken(tokens, index, state);
      continue;
    }
    if (token === "--query" || token.startsWith("--query=")) {
      if (state.fast) {
        state.unsupportedModeError =
          "Unsupported /gsd map-codebase query mode: cannot combine --query with --fast.";
        break;
      }
      if (state.focus !== undefined) {
        state.unsupportedModeError =
          "Unsupported /gsd map-codebase query mode: cannot combine --query with --focus.";
        break;
      }
      if (state.paths !== undefined) {
        state.unsupportedModeError =
          "Unsupported /gsd map-codebase query mode: cannot combine --query with --paths.";
        break;
      }
      if (state.existingMode !== undefined) {
        state.unsupportedModeError = `Unsupported /gsd map-codebase query mode: cannot combine --query with ${state.existingMode}.`;
        break;
      }
      index = parseMapCodebaseQueryToken(tokens, index, state);
      break;
    }
    if (token === "--paths" || token.startsWith("--paths=")) {
      const conflict = buildMapCodebaseQueryConflictMessage(state, "--paths");
      if (conflict !== undefined) {
        state.unsupportedModeError = conflict;
        break;
      }
      index = parseMapCodebasePathsToken(tokens, index, state);
      continue;
    }
    if (token === "refresh" || token === "update" || token === "skip") {
      const conflict = buildMapCodebaseQueryConflictMessage(state, token);
      if (conflict !== undefined) {
        state.unsupportedModeError = conflict;
        break;
      }
      if (state.existingMode !== undefined) {
        state.unsupportedModeError = `Unsupported /gsd map-codebase arguments: cannot combine ${state.existingMode} with ${token}.`;
        break;
      }
      state.existingMode = token;
      index += 1;
      continue;
    }
    if (!token.startsWith("-")) {
      state.unsupportedModeError = `Unsupported /gsd map-codebase argument: ${token}. Local command does not support positional area scoping.`;
      break;
    }

    state.unsupportedModeError = `Unsupported /gsd map-codebase flag: ${token}.`;
    break;
  }

  return validateParsedArgs({
    subcommand: "map-codebase",
    ...(state.paths === undefined ? {} : { paths: state.paths }),
    ...(state.fast ? { fast: true } : {}),
    ...(state.focus === undefined ? {} : { focus: state.focus }),
    ...(state.query === undefined ? {} : { query: state.query }),
    ...(state.existingMode === undefined ? {} : { existingMode: state.existingMode }),
    ...(state.unsupportedModeError === undefined
      ? {}
      : { unsupportedModeError: state.unsupportedModeError }),
  });
}

export function parseGsdCommandArgs(input: string): GsdCommandArgs {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  const subcommand = tokens[0];

  if (subcommand === "new-project") {
    return parseNewProjectArgs(tokens);
  }

  if (subcommand === "new-milestone") {
    return validateParsedArgs({
      subcommand,
      milestone: normalizeFreeform(tokens.slice(1).join(" ")),
    });
  }

  if (subcommand === "complete-milestone" || subcommand === "milestone-summary") {
    return validateParsedArgs({
      subcommand,
      version: normalizeFreeform(tokens.slice(1).join(" ")),
    });
  }

  if (subcommand === "debug") {
    return parseDebugArgs(tokens);
  }

  if (subcommand === "map-codebase") {
    return parseMapCodebaseArgs(tokens);
  }

  let phase: string | undefined;
  let paths: string[] | undefined;

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--phase") {
      phase = normalizePhaseToken(tokens[index + 1]);
      index += 1;
      continue;
    }
    if (token.startsWith("--phase=")) {
      phase = normalizePhaseToken(token.slice("--phase=".length));
      continue;
    }
    if (token === "--paths") {
      paths = normalizePathToken(tokens[index + 1]);
      index += 1;
      continue;
    }
    if (token.startsWith("--paths=")) {
      paths = normalizePathToken(token.slice("--paths=".length));
      continue;
    }
    if (!token.startsWith("-") && phase === undefined) {
      phase = normalizePhaseToken(token);
    }
  }

  const parsed: GsdCommandArgs = {
    ...(subcommand === undefined ? {} : { subcommand }),
    ...(phase === undefined ? {} : { phase }),
    ...(paths === undefined ? {} : { paths }),
  };
  return validateParsedArgs(parsed);
}

export function isPhaseOverrideSubcommand(
  subcommand: GsdSubcommand | undefined,
): subcommand is
  | "discuss-phase"
  | "plan-phase"
  | "execute-phase"
  | "verify-work"
  | "validate-phase"
  | "next" {
  return (
    subcommand === "discuss-phase" ||
    subcommand === "plan-phase" ||
    subcommand === "execute-phase" ||
    subcommand === "verify-work" ||
    subcommand === "validate-phase" ||
    subcommand === "next"
  );
}

export function usesParsedArgs(subcommand: GsdSubcommand | undefined): boolean {
  return (
    isPhaseOverrideSubcommand(subcommand) ||
    subcommand === "map-codebase" ||
    subcommand === "new-project" ||
    subcommand === "new-milestone" ||
    subcommand === "complete-milestone" ||
    subcommand === "milestone-summary" ||
    subcommand === "debug"
  );
}
