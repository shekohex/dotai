import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { Theme } from "../../../node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.js";

const colorValueSchema = Type.Union([Type.String(), Type.Integer({ minimum: 0, maximum: 255 })]);

type ColorValue = string | number;

const themeColorKeys = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "userMessageText",
  "customMessageText",
  "customMessageLabel",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "bashMode",
] as const;

const themeBackgroundKeys = [
  "selectedBg",
  "userMessageBg",
  "customMessageBg",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
] as const;

const themeColorsSchema = Type.Object(
  Object.fromEntries(
    [...themeColorKeys, ...themeBackgroundKeys].map((key) => [key, colorValueSchema]),
  ),
);

const remoteThemeJsonSchema = Type.Object({
  $schema: Type.Optional(Type.String()),
  name: Type.String(),
  vars: Type.Optional(Type.Record(Type.String(), colorValueSchema)),
  colors: themeColorsSchema,
  export: Type.Optional(
    Type.Object({
      pageBg: Type.Optional(colorValueSchema),
      cardBg: Type.Optional(colorValueSchema),
      infoBg: Type.Optional(colorValueSchema),
    }),
  ),
});

type RemoteThemeJson = {
  name: string;
  vars?: Record<string, ColorValue>;
  colors: Record<string, ColorValue>;
};

type ColorMode = "truecolor" | "256color";

const remoteThemeValidator = Compile(remoteThemeJsonSchema);

function detectColorMode(): ColorMode {
  const colorterm = process.env.COLORTERM;
  if (colorterm === "truecolor" || colorterm === "24bit") {
    return "truecolor";
  }
  if ((process.env.WT_SESSION ?? "") !== "") {
    return "truecolor";
  }
  const term = process.env.TERM ?? "";
  if (term === "dumb" || term === "" || term === "linux") {
    return "256color";
  }
  if (process.env.TERM_PROGRAM === "Apple_Terminal") {
    return "256color";
  }
  if (term === "screen" || term.startsWith("screen-") || term.startsWith("screen.")) {
    return "256color";
  }
  return "truecolor";
}

function parseRemoteThemeJson(label: string, content: string): RemoteThemeJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse theme ${label}: ${errorMessage}`, { cause: error });
  }

  if (remoteThemeValidator.Check(parsed)) {
    return parsed;
  }

  const firstError = remoteThemeValidator.Errors(parsed)[0];
  if (firstError !== undefined) {
    throw new Error(
      `Invalid theme ${label} at ${firstError.instancePath || "/"}: ${firstError.message}`,
    );
  }

  throw new Error(`Invalid theme ${label}`);
}

function resolveVarRefs(
  value: ColorValue,
  vars: Record<string, ColorValue>,
  visited = new Set<string>(),
): string | number {
  if (typeof value === "number" || value === "" || value.startsWith("#")) {
    return value;
  }
  if (visited.has(value)) {
    throw new Error(`Circular variable reference detected: ${value}`);
  }
  if (!(value in vars)) {
    throw new Error(`Variable reference not found: ${value}`);
  }
  visited.add(value);
  return resolveVarRefs(vars[value], vars, visited);
}

function resolveThemeColors(
  colors: Record<string, ColorValue>,
  vars: Record<string, ColorValue> = {},
): Record<string, string | number> {
  const resolved: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(colors)) {
    resolved[key] = resolveVarRefs(value, vars);
  }
  return resolved;
}

function buildThemeColorMap(
  keys: readonly string[],
  resolvedColors: Record<string, string | number>,
): Record<string, string | number> {
  const result: Record<string, string | number> = {};

  for (const key of keys) {
    const value = resolvedColors[key];
    if (value === undefined) {
      throw new Error(`Theme color not found: ${key}`);
    }
    result[key] = value;
  }

  return result;
}

export function createRemoteThemeFromContent(input: {
  sourcePath: string;
  content: string;
}): Theme {
  const themeJson = parseRemoteThemeJson(input.sourcePath, input.content);
  const resolvedColors = resolveThemeColors(themeJson.colors, themeJson.vars ?? {});
  const foregroundColors = buildThemeColorMap(themeColorKeys, resolvedColors);
  const backgroundColors = buildThemeColorMap(themeBackgroundKeys, resolvedColors);

  return new Theme(foregroundColors, backgroundColors, detectColorMode(), {
    name: themeJson.name,
    sourcePath: input.sourcePath,
  });
}
