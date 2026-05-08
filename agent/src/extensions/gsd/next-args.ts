import type { GsdCommandArgs } from "./args.js";

type NextArgHelpers = {
  normalizePhaseToken: (token: string | undefined) => string | undefined;
  validateParsedArgs: (parsed: GsdCommandArgs) => GsdCommandArgs;
};

export function parseNextArgs(tokens: string[], helpers: NextArgHelpers): GsdCommandArgs {
  let phase: string | undefined;
  let force = false;
  let unsupportedModeError: string | undefined;
  const missingPhaseValueError = "Unsupported /gsd next flag: --phase requires a value.";

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--phase") {
      const nextToken = tokens[index + 1];
      if (nextToken === undefined || nextToken.startsWith("-")) {
        unsupportedModeError ??= missingPhaseValueError;
        continue;
      }
      phase = helpers.normalizePhaseToken(nextToken);
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
      phase = helpers.normalizePhaseToken(rawPhase);
      if (phase === undefined) {
        unsupportedModeError ??= missingPhaseValueError;
      }
      continue;
    }
    if (token === "--force") {
      force = true;
      continue;
    }
    if (!token.startsWith("-") && phase === undefined) {
      phase = helpers.normalizePhaseToken(token);
      continue;
    }
    if (token.startsWith("-")) {
      unsupportedModeError ??= `Unsupported /gsd next flag: ${token}.`;
      continue;
    }
    unsupportedModeError ??= `Unsupported /gsd next argument: ${token}.`;
  }

  return helpers.validateParsedArgs({
    subcommand: "next",
    ...(phase === undefined ? {} : { phase }),
    ...(force ? { force: true } : {}),
    ...(unsupportedModeError === undefined ? {} : { unsupportedModeError }),
  });
}
