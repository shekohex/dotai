import type { GsdCommandArgs } from "./args.js";

export function parseSecurePhaseArgs(
  tokens: string[],
  helpers: {
    normalizePhaseToken: (token: string | undefined) => string | undefined;
    validateParsedArgs: (parsed: GsdCommandArgs) => GsdCommandArgs;
  },
): GsdCommandArgs {
  let phase: string | undefined;
  let unsupportedModeError: string | undefined;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--phase") {
      phase = helpers.normalizePhaseToken(tokens[index + 1]);
      if (phase === undefined) {
        unsupportedModeError ??= "Unsupported /gsd secure-phase flag: --phase requires a value.";
      }
      index += 1;
      continue;
    }
    if (token.startsWith("--phase=")) {
      phase = helpers.normalizePhaseToken(token.slice("--phase=".length));
      if (phase === undefined) {
        unsupportedModeError ??= "Unsupported /gsd secure-phase flag: --phase requires a value.";
      }
      continue;
    }
    if (!token.startsWith("-") && phase === undefined) {
      phase = helpers.normalizePhaseToken(token);
      continue;
    }
    if (!token.startsWith("-")) {
      unsupportedModeError ??= `Unsupported /gsd secure-phase extra positional argument: ${token}.`;
      continue;
    }
    unsupportedModeError ??= `Unsupported /gsd secure-phase flag: ${token}.`;
  }
  return helpers.validateParsedArgs({
    subcommand: "secure-phase",
    ...(phase === undefined ? {} : { phase }),
    ...(unsupportedModeError === undefined ? {} : { unsupportedModeError }),
  });
}
