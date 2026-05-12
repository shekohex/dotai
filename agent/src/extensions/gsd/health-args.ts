import type { GsdCommandArgs } from "./args.js";

type HealthParserDependencies = {
  normalizeFreeform: (token: string | undefined) => string | undefined;
  validateParsedArgs: (parsed: GsdCommandArgs) => GsdCommandArgs;
};

export function parseHealthArgs(
  tokens: string[],
  { normalizeFreeform, validateParsedArgs }: HealthParserDependencies,
): GsdCommandArgs {
  let repair = false;
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
      tokensUsed = nextToken;
      index += 1;
      continue;
    }
    if (token.startsWith("--tokens-used=")) {
      tokensUsed = normalizeFreeform(token.slice("--tokens-used=".length));
      if (tokensUsed === undefined || tokensUsed.startsWith("--")) {
        unsupportedModeError ??= "Unsupported /gsd health flag: --tokens-used requires a value.";
        continue;
      }
      continue;
    }
    if (token === "--context-window") {
      const nextToken = normalizeFreeform(tokens[index + 1]);
      if (nextToken === undefined || nextToken.startsWith("--")) {
        unsupportedModeError ??= "Unsupported /gsd health flag: --context-window requires a value.";
        continue;
      }
      contextWindow = nextToken;
      index += 1;
      continue;
    }
    if (token.startsWith("--context-window=")) {
      contextWindow = normalizeFreeform(token.slice("--context-window=".length));
      if (contextWindow === undefined || contextWindow.startsWith("--")) {
        unsupportedModeError ??= "Unsupported /gsd health flag: --context-window requires a value.";
        continue;
      }
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

  return validateParsedArgs({
    subcommand: "health",
    ...(repair ? { repair: true } : {}),
    ...(context ? { context: true } : {}),
    ...(tokensUsed === undefined ? {} : { tokensUsed }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(unsupportedModeError === undefined ? {} : { unsupportedModeError }),
  });
}
