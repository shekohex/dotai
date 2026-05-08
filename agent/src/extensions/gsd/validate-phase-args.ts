import type { GsdCommandArgs } from "./args.js";

type ParseValidatePhaseArgsDeps = {
  normalizePhaseToken: (token: string | undefined) => string | undefined;
  validateParsedArgs: (parsed: GsdCommandArgs) => GsdCommandArgs;
};

export function parseValidatePhaseArgs(
  tokens: string[],
  deps: ParseValidatePhaseArgsDeps,
): GsdCommandArgs {
  let phase: string | undefined;
  let unsupportedModeError: string | undefined;
  const missingPhaseValueError = "Unsupported /gsd validate-phase flag: --phase requires a value.";

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--phase") {
      const nextToken = tokens[index + 1];
      if (nextToken === undefined || nextToken.startsWith("-")) {
        unsupportedModeError ??= missingPhaseValueError;
        continue;
      }
      phase = deps.normalizePhaseToken(nextToken);
      if (phase === undefined) {
        unsupportedModeError ??= missingPhaseValueError;
      }
      index += 1;
      continue;
    }
    if (token.startsWith("--phase=")) {
      const rawPhase = token.slice("--phase=".length);
      if (rawPhase.length === 0 || rawPhase.startsWith("-")) {
        unsupportedModeError ??= missingPhaseValueError;
        continue;
      }
      phase = deps.normalizePhaseToken(rawPhase);
      if (phase === undefined) {
        unsupportedModeError ??= missingPhaseValueError;
      }
      continue;
    }
    if (!token.startsWith("-") && phase === undefined) {
      phase = deps.normalizePhaseToken(token);
      continue;
    }
    if (!token.startsWith("-")) {
      unsupportedModeError ??= `Unsupported /gsd validate-phase extra positional argument: ${token}.`;
      continue;
    }
    unsupportedModeError ??= `Unsupported /gsd validate-phase flag: ${token}.`;
  }

  return deps.validateParsedArgs({
    subcommand: "validate-phase",
    ...(phase === undefined ? {} : { phase }),
    ...(unsupportedModeError === undefined ? {} : { unsupportedModeError }),
  });
}
