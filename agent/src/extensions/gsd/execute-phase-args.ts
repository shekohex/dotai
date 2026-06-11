import type { GsdCommandArgs } from "./args.js";

type ParseExecutePhaseArgsDeps = {
  normalizePhaseToken: (token: string | undefined) => string | undefined;
  normalizePositiveIntegerToken: (token: string | undefined) => string | undefined;
  validateParsedArgs: (parsed: GsdCommandArgs) => GsdCommandArgs;
};

export function parseExecutePhaseArgs(
  tokens: string[],
  deps: ParseExecutePhaseArgsDeps,
): GsdCommandArgs {
  let phase: string | undefined;
  let wave: string | undefined;
  let gapsOnly = false;
  let interactive = false;
  let validate = false;
  let auto = false;
  let crossAi = false;
  let noCrossAi = false;
  let tdd = false;
  let mvp = false;
  let text = false;
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
    if (token === "--wave") {
      wave = deps.normalizePositiveIntegerToken(tokens[index + 1]);
      if (wave === undefined) {
        unsupportedModeError ??=
          "Unsupported /gsd execute-phase flag: --wave requires positive integer value.";
      }
      index += 1;
      continue;
    }
    if (token.startsWith("--wave=")) {
      wave = deps.normalizePositiveIntegerToken(token.slice("--wave=".length));
      if (wave === undefined) {
        unsupportedModeError ??=
          "Unsupported /gsd execute-phase flag: --wave requires positive integer value.";
      }
      continue;
    }
    if (token === "--gaps-only") {
      gapsOnly = true;
      continue;
    }
    if (token === "--interactive") {
      interactive = true;
      continue;
    }
    if (token === "--validate") {
      validate = true;
      continue;
    }
    if (token === "--text") {
      text = true;
      continue;
    }
    if (token === "--auto") {
      auto = true;
      continue;
    }
    if (token === "--cross-ai") {
      crossAi = true;
      continue;
    }
    if (token === "--no-cross-ai") {
      noCrossAi = true;
      continue;
    }
    if (token === "--tdd") {
      tdd = true;
      continue;
    }
    if (token === "--mvp") {
      mvp = true;
      continue;
    }
    if (!token.startsWith("-") && phase === undefined) {
      phase = deps.normalizePhaseToken(token);
      continue;
    }
    if (!token.startsWith("-") && phase !== undefined) {
      unsupportedModeError ??= `Unsupported /gsd execute-phase extra positional argument: ${token}.`;
      continue;
    }
    if (token.startsWith("-")) {
      unsupportedModeError ??= `Unsupported /gsd execute-phase flag: ${token}.`;
    }
  }

  return deps.validateParsedArgs({
    subcommand: "execute-phase",
    ...(phase === undefined ? {} : { phase }),
    ...(wave === undefined ? {} : { wave }),
    ...(gapsOnly ? { gapsOnly: true } : {}),
    ...(interactive ? { interactive: true } : {}),
    ...(validate ? { validate: true } : {}),
    ...(text ? { text: true } : {}),
    ...(auto ? { auto: true } : {}),
    ...(crossAi ? { crossAi: true } : {}),
    ...(noCrossAi ? { noCrossAi: true } : {}),
    ...(tdd ? { tdd: true } : {}),
    ...(mvp ? { mvp: true } : {}),
    ...(unsupportedModeError === undefined ? {} : { unsupportedModeError }),
  });
}
