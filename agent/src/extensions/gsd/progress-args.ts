import type { GsdCommandArgs } from "./args.js";

type ProgressArgHelpers = {
  normalizePhaseToken: (token: string | undefined) => string | undefined;
  validateParsedArgs: (parsed: GsdCommandArgs) => GsdCommandArgs;
};

export function parseProgressArgs(tokens: string[], helpers: ProgressArgHelpers): GsdCommandArgs {
  let phase: string | undefined;
  let next = false;
  let doMode = false;
  let forensic = false;
  let unsupportedModeError: string | undefined;
  const missingPhaseValueError = "Unsupported /gsd progress flag: --phase requires a value.";
  const normalizeProgressPhaseValue = (token: string | undefined): string | undefined => {
    const value = helpers.normalizePhaseToken(token);
    if (value === undefined || value.startsWith("-")) {
      return undefined;
    }
    return value;
  };

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--phase") {
      const nextToken = tokens[index + 1];
      phase = normalizeProgressPhaseValue(nextToken);
      if (phase === undefined) {
        unsupportedModeError ??= missingPhaseValueError;
        continue;
      }
      index += 1;
      continue;
    }
    if (token.startsWith("--phase=")) {
      phase = normalizeProgressPhaseValue(token.slice("--phase=".length));
      if (phase === undefined) {
        unsupportedModeError ??= missingPhaseValueError;
      }
      continue;
    }
    if (token === "--next") {
      next = true;
      continue;
    }
    if (token === "--do") {
      doMode = true;
      unsupportedModeError ??=
        "Unsupported /gsd progress mode: --do. Local command does not implement routed execution from progress yet.";
      continue;
    }
    if (token === "--forensic") {
      forensic = true;
      unsupportedModeError ??=
        "Unsupported /gsd progress mode: --forensic. Local command does not implement forensic workflow routing yet.";
      continue;
    }
    if (!token.startsWith("-") && phase === undefined) {
      phase = helpers.normalizePhaseToken(token);
      continue;
    }
    if (token.startsWith("-")) {
      unsupportedModeError ??= `Unsupported /gsd progress flag: ${token}.`;
      continue;
    }
    unsupportedModeError ??= `Unsupported /gsd progress argument: ${token}.`;
  }

  if (phase !== undefined && !next) {
    unsupportedModeError ??=
      "Unsupported /gsd progress phase override: use --next with a positional phase or --phase.";
  }

  return helpers.validateParsedArgs({
    subcommand: "progress",
    ...(phase === undefined ? {} : { phase }),
    ...(next ? { next: true } : {}),
    ...(doMode ? { doMode: true } : {}),
    ...(forensic ? { forensic: true } : {}),
    ...(unsupportedModeError === undefined ? {} : { unsupportedModeError }),
  });
}
