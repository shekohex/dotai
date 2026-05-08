import type { GsdCommandArgs } from "./args.js";

type StatsArgHelpers = {
  normalizeFreeform: (token: string | undefined) => string | undefined;
  validateParsedArgs: (parsed: GsdCommandArgs) => GsdCommandArgs;
};

export function parseStatsArgs(tokens: string[], helpers: StatsArgHelpers): GsdCommandArgs {
  let outputMode: GsdCommandArgs["outputMode"];
  let unsupportedModeError: string | undefined;

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "json" || token === "table") {
      if (outputMode === undefined) {
        outputMode = token;
      } else {
        unsupportedModeError ??= `Unsupported /gsd stats argument: ${token}.`;
      }
      continue;
    }
    if (token === "--json" || token === "--table") {
      const nextOutputMode = token === "--json" ? "json" : "table";
      if (outputMode === undefined) {
        outputMode = nextOutputMode;
      } else {
        unsupportedModeError ??= "Unsupported /gsd stats mode: multiple output modes requested.";
      }
      continue;
    }
    if (token.startsWith("--format=")) {
      const format = helpers.normalizeFreeform(token.slice("--format=".length));
      if (format === "json" || format === "table") {
        if (outputMode === undefined) {
          outputMode = format;
        } else {
          unsupportedModeError ??= "Unsupported /gsd stats mode: multiple output modes requested.";
        }
      } else {
        unsupportedModeError ??= `Unsupported /gsd stats format: ${format ?? ""}.`;
      }
      continue;
    }
    if (token === "--format") {
      const format = helpers.normalizeFreeform(tokens[index + 1]);
      if (format === "json" || format === "table") {
        if (outputMode === undefined) {
          outputMode = format;
        } else {
          unsupportedModeError ??= "Unsupported /gsd stats mode: multiple output modes requested.";
        }
      } else {
        unsupportedModeError ??= `Unsupported /gsd stats format: ${format ?? ""}.`;
      }
      index += 1;
      continue;
    }
    unsupportedModeError ??= token.startsWith("-")
      ? `Unsupported /gsd stats flag: ${token}.`
      : `Unsupported /gsd stats argument: ${token}.`;
  }

  return helpers.validateParsedArgs({
    subcommand: "stats",
    ...(outputMode === undefined ? {} : { outputMode }),
    ...(unsupportedModeError === undefined ? {} : { unsupportedModeError }),
  });
}
