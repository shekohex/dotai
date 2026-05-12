import type { GsdCommandArgs } from "./args.js";

type HealthParserDependencies = {
  normalizeFreeform: (token: string | undefined) => string | undefined;
  validateParsedArgs: (parsed: GsdCommandArgs) => GsdCommandArgs;
};

function isNonNegativeInteger(value: string): boolean {
  return /^\d+$/u.test(value);
}

function isPositiveInteger(value: string): boolean {
  return /^[1-9]\d*$/u.test(value);
}

export function parseHealthArgs(
  tokens: string[],
  { normalizeFreeform, validateParsedArgs }: HealthParserDependencies,
): GsdCommandArgs {
  let repair = false;
  let backfill = false;
  let context = false;
  let tokensUsed: string | undefined;
  let contextWindow: string | undefined;
  let unsupportedModeError: string | undefined;

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--repair") {
      repair = true;
      continue;
    }
    if (token === "--backfill") {
      backfill = true;
      continue;
    }
    if (token === "--context") {
      context = true;
      continue;
    }
    if (token === "--tokens-used") {
      const nextToken = normalizeFreeform(tokens[index + 1]);
      if (nextToken === undefined || nextToken.startsWith("--")) {
        unsupportedModeError ??= "Unsupported /gsd health flag: --tokens-used requires a value.";
        continue;
      }
      if (!isNonNegativeInteger(nextToken)) {
        unsupportedModeError ??=
          "Unsupported /gsd health flag: --tokens-used requires non-negative integer value.";
        continue;
      }
      tokensUsed = nextToken;
      index += 1;
      continue;
    }
    if (token.startsWith("--tokens-used=")) {
      const inlineTokensUsed = normalizeFreeform(token.slice("--tokens-used=".length));
      if (inlineTokensUsed === undefined || inlineTokensUsed.startsWith("--")) {
        unsupportedModeError ??= "Unsupported /gsd health flag: --tokens-used requires a value.";
        continue;
      }
      if (!isNonNegativeInteger(inlineTokensUsed)) {
        unsupportedModeError ??=
          "Unsupported /gsd health flag: --tokens-used requires non-negative integer value.";
        continue;
      }
      tokensUsed = inlineTokensUsed;
      continue;
    }
    if (token === "--context-window") {
      const nextToken = normalizeFreeform(tokens[index + 1]);
      if (nextToken === undefined || nextToken.startsWith("--")) {
        unsupportedModeError ??= "Unsupported /gsd health flag: --context-window requires a value.";
        continue;
      }
      if (!isPositiveInteger(nextToken)) {
        unsupportedModeError ??=
          "Unsupported /gsd health flag: --context-window requires positive integer value.";
        continue;
      }
      contextWindow = nextToken;
      index += 1;
      continue;
    }
    if (token.startsWith("--context-window=")) {
      const inlineContextWindow = normalizeFreeform(token.slice("--context-window=".length));
      if (inlineContextWindow === undefined || inlineContextWindow.startsWith("--")) {
        unsupportedModeError ??= "Unsupported /gsd health flag: --context-window requires a value.";
        continue;
      }
      if (!isPositiveInteger(inlineContextWindow)) {
        unsupportedModeError ??=
          "Unsupported /gsd health flag: --context-window requires positive integer value.";
        continue;
      }
      contextWindow = inlineContextWindow;
      continue;
    }
    unsupportedModeError ??= `Unsupported /gsd health flag: ${token}.`;
  }

  if (!context && (tokensUsed !== undefined || contextWindow !== undefined)) {
    unsupportedModeError ??=
      "Unsupported /gsd health context mode: add --context when passing context utilization flags.";
  }
  if (repair && context) {
    unsupportedModeError ??=
      "Unsupported /gsd health mode: choose either --repair or --context per run.";
  }
  if (backfill && context) {
    unsupportedModeError ??=
      "Unsupported /gsd health mode: choose either --backfill or --context per run.";
  }

  return validateParsedArgs({
    subcommand: "health",
    ...(repair ? { repair: true } : {}),
    ...(backfill ? { backfill: true } : {}),
    ...(context ? { context: true } : {}),
    ...(tokensUsed === undefined ? {} : { tokensUsed }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(unsupportedModeError === undefined ? {} : { unsupportedModeError }),
  });
}
