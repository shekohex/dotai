import type { GsdCommandArgs } from "./args.js";

type ParseVerifyWorkArgsDeps = {
  normalizePhaseToken: (token: string | undefined) => string | undefined;
  validateParsedArgs: (parsed: GsdCommandArgs) => GsdCommandArgs;
};

export function parseVerifyWorkArgs(
  tokens: string[],
  deps: ParseVerifyWorkArgsDeps,
): GsdCommandArgs {
  let phase: string | undefined;
  let unsupportedModeError: string | undefined;

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--phase") {
      phase = deps.normalizePhaseToken(tokens[index + 1]);
      index += 1;
      continue;
    }
    if (token.startsWith("--phase=")) {
      phase = deps.normalizePhaseToken(token.slice("--phase=".length));
      continue;
    }
    if (!token.startsWith("-") && phase === undefined) {
      phase = deps.normalizePhaseToken(token);
      continue;
    }
    if (!token.startsWith("-") && phase !== undefined) {
      unsupportedModeError ??= `Unsupported /gsd verify-work extra positional argument: ${token}.`;
      continue;
    }
    if (token.startsWith("-")) {
      unsupportedModeError ??= `Unsupported /gsd verify-work flag: ${token}.`;
    }
  }

  return deps.validateParsedArgs({
    subcommand: "verify-work",
    ...(phase === undefined ? {} : { phase }),
    ...(unsupportedModeError === undefined ? {} : { unsupportedModeError }),
  });
}
