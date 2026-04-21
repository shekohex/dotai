import { Type } from "@sinclair/typebox";

export const RemoteSkillResourceSchema = Type.Object({
  name: Type.String(),
  description: Type.String(),
  filePath: Type.String(),
  baseDir: Type.String(),
  disableModelInvocation: Type.Boolean(),
  content: Type.String(),
});

export const RemotePromptResourceSchema = Type.Object({
  name: Type.String(),
  description: Type.String(),
  filePath: Type.String(),
  content: Type.String(),
});

export const RemoteThemeResourceSchema = Type.Object({
  name: Type.String(),
  sourcePath: Type.String(),
  content: Type.String(),
});

export const RemoteResourceBundleSchema = Type.Object({
  skills: Type.Array(RemoteSkillResourceSchema),
  prompts: Type.Array(RemotePromptResourceSchema),
  themes: Type.Array(RemoteThemeResourceSchema),
  systemPrompt: Type.Union([Type.String(), Type.Null()]),
  appendSystemPrompt: Type.Array(Type.String()),
});

const PackageSourceSchema = Type.Union([
  Type.String(),
  Type.Object({
    source: Type.String(),
    extensions: Type.Optional(Type.Array(Type.String())),
    skills: Type.Optional(Type.Array(Type.String())),
    prompts: Type.Optional(Type.Array(Type.String())),
    themes: Type.Optional(Type.Array(Type.String())),
  }),
]);

export const RemoteSettingsSnapshotSchema = Type.Object(
  {
    lastChangelogVersion: Type.Optional(Type.String()),
    defaultProvider: Type.Optional(Type.String()),
    defaultModel: Type.Optional(Type.String()),
    defaultThinkingLevel: Type.Optional(
      Type.Union([
        Type.Literal("off"),
        Type.Literal("minimal"),
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
        Type.Literal("xhigh"),
      ]),
    ),
    transport: Type.Optional(
      Type.Union([Type.Literal("sse"), Type.Literal("websocket"), Type.Literal("auto")]),
    ),
    steeringMode: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")])),
    followUpMode: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")])),
    theme: Type.Optional(Type.String()),
    compaction: Type.Optional(
      Type.Object({
        enabled: Type.Optional(Type.Boolean()),
        reserveTokens: Type.Optional(Type.Number()),
        keepRecentTokens: Type.Optional(Type.Number()),
      }),
    ),
    branchSummary: Type.Optional(
      Type.Object({
        reserveTokens: Type.Optional(Type.Number()),
        skipPrompt: Type.Optional(Type.Boolean()),
      }),
    ),
    retry: Type.Optional(
      Type.Object({
        enabled: Type.Optional(Type.Boolean()),
        maxRetries: Type.Optional(Type.Number()),
        baseDelayMs: Type.Optional(Type.Number()),
        maxDelayMs: Type.Optional(Type.Number()),
      }),
    ),
    hideThinkingBlock: Type.Optional(Type.Boolean()),
    shellPath: Type.Optional(Type.String()),
    quietStartup: Type.Optional(Type.Boolean()),
    shellCommandPrefix: Type.Optional(Type.String()),
    npmCommand: Type.Optional(Type.Array(Type.String())),
    collapseChangelog: Type.Optional(Type.Boolean()),
    enableInstallTelemetry: Type.Optional(Type.Boolean()),
    packages: Type.Optional(Type.Array(PackageSourceSchema)),
    extensions: Type.Optional(Type.Array(Type.String())),
    skills: Type.Optional(Type.Array(Type.String())),
    prompts: Type.Optional(Type.Array(Type.String())),
    themes: Type.Optional(Type.Array(Type.String())),
    enableSkillCommands: Type.Optional(Type.Boolean()),
    terminal: Type.Optional(
      Type.Object({
        showImages: Type.Optional(Type.Boolean()),
        clearOnShrink: Type.Optional(Type.Boolean()),
      }),
    ),
    images: Type.Optional(
      Type.Object({
        autoResize: Type.Optional(Type.Boolean()),
        blockImages: Type.Optional(Type.Boolean()),
      }),
    ),
    enabledModels: Type.Optional(Type.Array(Type.String())),
    doubleEscapeAction: Type.Optional(
      Type.Union([Type.Literal("fork"), Type.Literal("tree"), Type.Literal("none")]),
    ),
    treeFilterMode: Type.Optional(
      Type.Union([
        Type.Literal("default"),
        Type.Literal("no-tools"),
        Type.Literal("user-only"),
        Type.Literal("labeled-only"),
        Type.Literal("all"),
      ]),
    ),
    thinkingBudgets: Type.Optional(
      Type.Object({
        minimal: Type.Optional(Type.Number()),
        low: Type.Optional(Type.Number()),
        medium: Type.Optional(Type.Number()),
        high: Type.Optional(Type.Number()),
      }),
    ),
    editorPaddingX: Type.Optional(Type.Number()),
    autocompleteMaxVisible: Type.Optional(Type.Number()),
    showHardwareCursor: Type.Optional(Type.Boolean()),
    markdown: Type.Optional(
      Type.Object({
        codeBlockIndent: Type.Optional(Type.String()),
      }),
    ),
    sessionDir: Type.Optional(Type.String()),
  },
  {
    additionalProperties: false,
  },
);
