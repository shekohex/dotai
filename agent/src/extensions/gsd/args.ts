import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { GsdSubcommand } from "./commands.js";

export const GsdCommandArgsSchema = Type.Object(
  {
    subcommand: Type.Optional(Type.String()),
    phase: Type.Optional(Type.String()),
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

export function parseGsdCommandArgs(input: string): GsdCommandArgs {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  const subcommand = tokens[0];
  let phase: string | undefined;

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
    if (!token.startsWith("-") && phase === undefined) {
      phase = normalizePhaseToken(token);
    }
  }

  const parsed = {
    subcommand,
    phase,
  };
  if (!Value.Check(GsdCommandArgsSchema, parsed)) {
    return {};
  }
  return parsed;
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
