import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { GsdSubcommand } from "./commands.js";

export const GsdCommandArgsSchema = Type.Object(
  {
    subcommand: Type.Optional(Type.String()),
    phase: Type.Optional(Type.String()),
    paths: Type.Optional(Type.Array(Type.String())),
    version: Type.Optional(Type.String()),
    milestone: Type.Optional(Type.String()),
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

export function parseGsdCommandArgs(input: string): GsdCommandArgs {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  const subcommand = tokens[0];

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
    subcommand === "new-milestone" ||
    subcommand === "complete-milestone" ||
    subcommand === "milestone-summary" ||
    subcommand === "debug"
  );
}
