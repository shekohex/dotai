import type { ThemeColor as PackageThemeColor } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";

const themeColorNames = [
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
] as const satisfies readonly PackageThemeColor[];

export type ThemeColor = (typeof themeColorNames)[number];

export const ThemeColorSchema = Type.Unsafe<ThemeColor>({
  type: "string",
  enum: [...themeColorNames],
});

export const ThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
]);

export const TmuxTargetSchema = Type.Union([Type.Literal("pane"), Type.Literal("window")]);

export const ModeSpecSchema = Type.Object({
  description: Type.Optional(Type.String()),
  provider: Type.Optional(Type.String()),
  modelId: Type.Optional(Type.String()),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
  color: Type.Optional(ThemeColorSchema),
  tools: Type.Optional(Type.Array(Type.String())),
  systemPrompt: Type.Optional(Type.String()),
  systemPromptMode: Type.Optional(Type.Union([Type.Literal("append"), Type.Literal("replace")])),
  autoExit: Type.Optional(Type.Boolean()),
  autoExitTimeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
  tmuxTarget: Type.Optional(TmuxTargetSchema),
});

export const ModesFileSchema = Type.Object({
  version: Type.Literal(1),
  currentMode: Type.Optional(Type.String()),
  modes: Type.Record(Type.String(), ModeSpecSchema),
});

export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;
export type TmuxTarget = Static<typeof TmuxTargetSchema>;
export type ModeSpec = Static<typeof ModeSpecSchema>;
export type ModesFile = Static<typeof ModesFileSchema>;
export type ModeMap = Record<string, ModeSpec>;
export type ModesFileFor<TModes extends ModeMap> = {
  version: 1;
  currentMode?: Extract<keyof TModes, string>;
  modes: TModes;
};

export type LoadedModesFile = {
  path: string;
  source: "project" | "global" | "missing";
  data: ModesFile;
  resolvedData: ModesFile;
  error?: string;
};
