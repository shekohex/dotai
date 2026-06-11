import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { GsdSubcommand } from "./commands.js";
import { parseExecutePhaseArgs } from "./execute-phase-args.js";
import { parseHealthArgs } from "./health-args.js";
import { parseNextArgs } from "./next-args.js";
import { parseProgressArgs } from "./progress-args.js";
import { parseSecurePhaseArgs } from "./secure-phase-args.js";
import { parseStatsArgs } from "./stats-args.js";
import { parseValidatePhaseArgs } from "./validate-phase-args.js";
import { parseVerifyWorkArgs } from "./verify-work-args.js";

export const GsdCommandArgsSchema = Type.Object(
  {
    subcommand: Type.Optional(Type.String()),
    auto: Type.Optional(Type.Boolean()),
    resetPhaseNumbers: Type.Optional(Type.Boolean()),
    crossAi: Type.Optional(Type.Boolean()),
    noCrossAi: Type.Optional(Type.Boolean()),
    tdd: Type.Optional(Type.Boolean()),
    mvp: Type.Optional(Type.Boolean()),
    phase: Type.Optional(Type.String()),
    next: Type.Optional(Type.Boolean()),
    force: Type.Optional(Type.Boolean()),
    doMode: Type.Optional(Type.Boolean()),
    forensic: Type.Optional(Type.Boolean()),
    wave: Type.Optional(Type.String()),
    researchPhase: Type.Optional(Type.String()),
    assumptions: Type.Optional(Type.Boolean()),
    all: Type.Optional(Type.Boolean()),
    chain: Type.Optional(Type.Boolean()),
    text: Type.Optional(Type.Boolean()),
    view: Type.Optional(Type.Boolean()),
    research: Type.Optional(Type.Boolean()),
    skipResearch: Type.Optional(Type.Boolean()),
    skipVerify: Type.Optional(Type.Boolean()),
    gaps: Type.Optional(Type.Boolean()),
    reviews: Type.Optional(Type.Boolean()),
    gapsOnly: Type.Optional(Type.Boolean()),
    interactive: Type.Optional(Type.Boolean()),
    validate: Type.Optional(Type.Boolean()),
    analyze: Type.Optional(Type.Boolean()),
    batch: Type.Optional(Type.Boolean()),
    power: Type.Optional(Type.Boolean()),
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
    outputMode: Type.Optional(Type.Union([Type.Literal("json"), Type.Literal("table")])),
    repair: Type.Optional(Type.Boolean()),
    backfill: Type.Optional(Type.Boolean()),
    context: Type.Optional(Type.Boolean()),
    tokensUsed: Type.Optional(Type.String()),
    contextWindow: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type GsdCommandArgs = Static<typeof GsdCommandArgsSchema>;

function parseNewProjectArgs(tokens: string[]): GsdCommandArgs {
  let auto = false;
  let text = false;
  const parts: string[] = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--auto") {
      auto = true;
      continue;
    }
    if (token === "--text") {
      text = true;
      continue;
    }
    parts.push(token);
  }
  return validateParsedArgs({
    subcommand: "new-project",
    ...(auto ? { auto: true } : {}),
    ...(text ? { text: true } : {}),
    ...(parts.length > 0 ? { input: normalizeFreeform(parts.join(" ")) } : {}),
  });
}

function parseVersionWorkflowArgs(
  subcommand: "complete-milestone" | "milestone-summary",
  tokens: string[],
): GsdCommandArgs {
  let text = false;
  const parts: string[] = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--text") {
      text = true;
      continue;
    }
    parts.push(token);
  }
  return validateParsedArgs({
    subcommand,
    ...(text ? { text: true } : {}),
    version: normalizeFreeform(parts.join(" ")),
  });
}

function parseNewMilestoneArgs(tokens: string[]): GsdCommandArgs {
  let text = false;
  let resetPhaseNumbers = false;
  let unsupportedModeError: string | undefined;
  const milestoneParts: string[] = [];

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--text") {
      text = true;
      continue;
    }
    if (token === "--reset-phase-numbers") {
      resetPhaseNumbers = true;
      continue;
    }
    if (token.startsWith("-")) {
      unsupportedModeError ??= `Unsupported /gsd new-milestone flag: ${token}.`;
      continue;
    }
    milestoneParts.push(token);
  }

  return validateParsedArgs({
    subcommand: "new-milestone",
    ...(text ? { text: true } : {}),
    ...(resetPhaseNumbers ? { resetPhaseNumbers: true } : {}),
    ...(milestoneParts.length > 0
      ? { milestone: normalizeFreeform(milestoneParts.join(" ")) }
      : {}),
    ...(unsupportedModeError === undefined ? {} : { unsupportedModeError }),
  });
}

function normalizePhaseToken(token: string | undefined): string | undefined {
  const value = token?.trim();
  return value !== undefined && value.length > 0 ? value : undefined;
}

function normalizePositiveIntegerToken(token: string | undefined): string | undefined {
  const value = normalizePhaseToken(token);
  return value !== undefined && /^[1-9]\d*$/u.test(value) ? value : undefined;
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
  let text = false;
  const filteredTokens = tokens.filter((token, index) => {
    if (index === 0) {
      return true;
    }
    if (token === "--text") {
      text = true;
      return false;
    }
    if (token === "--diagnose") {
      diagnose = true;
      return false;
    }
    return true;
  });

  const action = filteredTokens[1];
  if (action === "list") {
    return validateParsedArgs({
      subcommand: "debug",
      debugAction: "list",
      diagnose,
      ...(text ? { text: true } : {}),
    });
  }
  if (action === "status") {
    return validateParsedArgs({
      subcommand: "debug",
      debugAction: "status",
      slug: normalizeFreeform(filteredTokens.slice(2).join(" ")),
      diagnose,
      ...(text ? { text: true } : {}),
    });
  }
  if (action === "continue") {
    return validateParsedArgs({
      subcommand: "debug",
      debugAction: "continue",
      slug: normalizeFreeform(filteredTokens.slice(2).join(" ")),
      diagnose,
      ...(text ? { text: true } : {}),
    });
  }
  return validateParsedArgs({
    subcommand: "debug",
    debugAction: "start",
    diagnose,
    description: normalizeFreeform(filteredTokens.slice(1).join(" ")),
    ...(text ? { text: true } : {}),
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

function parseDiscussPhaseArgs(tokens: string[]): GsdCommandArgs {
  let phase: string | undefined;
  let assumptions = false;
  let auto = false;
  let all = false;
  let chain = false;
  let text = false;
  let analyze = false;
  let batch = false;
  let power = false;
  const inputParts: string[] = [];
  let unsupportedModeError: string | undefined;

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
    if (token === "--text") {
      text = true;
      continue;
    }
    if (token === "--assumptions") {
      assumptions = true;
      continue;
    }
    if (token === "--auto") {
      auto = true;
      continue;
    }
    if (token === "--all") {
      all = true;
      continue;
    }
    if (token === "--chain") {
      chain = true;
      continue;
    }
    if (token === "--analyze") {
      analyze = true;
      unsupportedModeError ??=
        "Unsupported /gsd discuss-phase mode: --analyze overlay is parsed but not implemented in Slice 1.";
      continue;
    }
    if (token === "--batch") {
      batch = true;
      unsupportedModeError ??=
        "Unsupported /gsd discuss-phase mode: --batch overlay is parsed but not implemented in Slice 1.";
      continue;
    }
    if (token === "--power") {
      power = true;
      unsupportedModeError ??=
        "Unsupported /gsd discuss-phase mode: --power overlay is parsed but not implemented in Slice 1.";
      continue;
    }
    if (!token.startsWith("-") && phase === undefined) {
      phase = normalizePhaseToken(token);
      continue;
    }
    if (!token.startsWith("-")) {
      inputParts.push(token);
      continue;
    }
    if (token.startsWith("-")) {
      unsupportedModeError ??= `Unsupported /gsd discuss-phase flag: ${token}.`;
    }
  }

  const input = normalizeFreeform(inputParts.join(" "));

  return validateParsedArgs({
    subcommand: "discuss-phase",
    ...(phase === undefined ? {} : { phase }),
    ...(assumptions ? { assumptions: true } : {}),
    ...(auto ? { auto: true } : {}),
    ...(all ? { all: true } : {}),
    ...(chain ? { chain: true } : {}),
    ...(text ? { text: true } : {}),
    ...(input === undefined ? {} : { input }),
    ...(analyze ? { analyze: true } : {}),
    ...(batch ? { batch: true } : {}),
    ...(power ? { power: true } : {}),
    ...(unsupportedModeError === undefined ? {} : { unsupportedModeError }),
  });
}

function parsePlanPhaseArgs(tokens: string[]): GsdCommandArgs {
  let phase: string | undefined;
  let researchPhase: string | undefined;
  let text = false;
  let view = false;
  let research = false;
  let skipResearch = false;
  let skipVerify = false;
  let gaps = false;
  let reviews = false;
  let unsupportedModeError: string | undefined;

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
    if (token === "--research-phase") {
      researchPhase = normalizePhaseToken(tokens[index + 1]);
      index += 1;
      continue;
    }
    if (token.startsWith("--research-phase=")) {
      researchPhase = normalizePhaseToken(token.slice("--research-phase=".length));
      continue;
    }
    if (token === "--view") {
      view = true;
      continue;
    }
    if (token === "--research") {
      research = true;
      continue;
    }
    if (token === "--skip-research") {
      skipResearch = true;
      continue;
    }
    if (token === "--skip-verify") {
      skipVerify = true;
      continue;
    }
    if (token === "--gaps") {
      gaps = true;
      continue;
    }
    if (token === "--reviews") {
      reviews = true;
      continue;
    }
    if (token === "--text") {
      text = true;
      continue;
    }
    if (
      token === "--prd" ||
      token === "--auto" ||
      token === "--chain" ||
      token === "--bounce" ||
      token === "--skip-bounce" ||
      token === "--chunked" ||
      token === "--mvp" ||
      token === "--skip-ui" ||
      token === "--tdd"
    ) {
      unsupportedModeError ??= `Unsupported /gsd plan-phase flag: ${token}. Deferred in Slice 1.`;
      continue;
    }
    if (!token.startsWith("-") && phase === undefined && researchPhase === undefined) {
      phase = normalizePhaseToken(token);
      continue;
    }
    if (token.startsWith("-")) {
      unsupportedModeError ??= `Unsupported /gsd plan-phase flag: ${token}.`;
    }
  }

  if (view && researchPhase === undefined) {
    unsupportedModeError ??=
      "Unsupported /gsd plan-phase flag combination: --view only works with --research-phase in Slice 1.";
  }

  return validateParsedArgs({
    subcommand: "plan-phase",
    ...(phase === undefined ? {} : { phase }),
    ...(researchPhase === undefined ? {} : { researchPhase }),
    ...(text ? { text: true } : {}),
    ...(view ? { view: true } : {}),
    ...(research ? { research: true } : {}),
    ...(skipResearch ? { skipResearch: true } : {}),
    ...(skipVerify ? { skipVerify: true } : {}),
    ...(gaps ? { gaps: true } : {}),
    ...(reviews ? { reviews: true } : {}),
    ...(unsupportedModeError === undefined ? {} : { unsupportedModeError }),
  });
}

export function parseGsdCommandArgs(input: string): GsdCommandArgs {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  const subcommand = tokens[0];

  if (subcommand === "new-project") {
    return parseNewProjectArgs(tokens);
  }

  if (subcommand === "new-milestone") {
    return parseNewMilestoneArgs(tokens);
  }

  if (subcommand === "complete-milestone" || subcommand === "milestone-summary") {
    return parseVersionWorkflowArgs(subcommand, tokens);
  }

  if (subcommand === "debug") {
    return parseDebugArgs(tokens);
  }

  if (subcommand === "map-codebase") {
    return parseMapCodebaseArgs(tokens);
  }

  if (subcommand === "discuss-phase") {
    return parseDiscussPhaseArgs(tokens);
  }

  if (subcommand === "plan-phase") {
    return parsePlanPhaseArgs(tokens);
  }

  if (subcommand === "progress") {
    return parseProgressArgs(tokens, { normalizePhaseToken, validateParsedArgs });
  }

  if (subcommand === "stats") {
    return parseStatsArgs(tokens, {
      normalizeFreeform,
      validateParsedArgs,
    });
  }

  if (subcommand === "health") {
    return parseHealthArgs(tokens, { normalizeFreeform, validateParsedArgs });
  }

  if (subcommand === "execute-phase") {
    return parseExecutePhaseArgs(tokens, {
      normalizePhaseToken,
      normalizePositiveIntegerToken,
      validateParsedArgs,
    });
  }

  if (subcommand === "secure-phase") {
    return parseSecurePhaseArgs(tokens, { normalizePhaseToken, validateParsedArgs });
  }

  if (subcommand === "verify-work" || subcommand === "validate-phase") {
    return subcommand === "verify-work"
      ? parseVerifyWorkArgs(tokens, { normalizePhaseToken, validateParsedArgs })
      : parseValidatePhaseArgs(tokens, { normalizePhaseToken, validateParsedArgs });
  }

  if (subcommand === "next") {
    return parseNextArgs(tokens, { normalizePhaseToken, validateParsedArgs });
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
export function usesParsedArgs(subcommand: GsdSubcommand | undefined): boolean {
  return (
    subcommand === "discuss-phase" ||
    subcommand === "plan-phase" ||
    subcommand === "execute-phase" ||
    subcommand === "secure-phase" ||
    subcommand === "verify-work" ||
    subcommand === "validate-phase" ||
    subcommand === "next" ||
    subcommand === "progress" ||
    subcommand === "stats" ||
    subcommand === "health" ||
    subcommand === "map-codebase" ||
    subcommand === "new-project" ||
    subcommand === "new-milestone" ||
    subcommand === "complete-milestone" ||
    subcommand === "milestone-summary" ||
    subcommand === "debug"
  );
}
