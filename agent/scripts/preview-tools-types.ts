type PreviewScenariosModule = Awaited<typeof import("../test/tool-preview-scenarios.js")>;
type PreviewScenario = ReturnType<PreviewScenariosModule["getToolPreviewScenarios"]>[number];

type PreviewThemeRegistry = {
  names: string[];
  apply: (name: string) => void;
};

type PreviewState = {
  scenarioId?: string;
  themeName?: string;
  expandedPreview?: boolean;
  animationPaused?: boolean;
};

type PreviewPanel = ReturnType<PreviewScenariosModule["getToolPreviewPanels"]>[number];

type PreviewPanelEntry = {
  scenario: PreviewScenario;
  panel: PreviewPanel;
  component: ReturnType<PreviewScenariosModule["createPreviewComponent"]>;
};

type ThemeSpec = {
  name?: string;
  vars?: Record<string, string>;
  colors: Record<string, string>;
};

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value));
}

function toStringMap(value: unknown): Record<string, string> {
  const record = toRecord(value);
  if (!record) {
    return {};
  }
  const entries = Object.entries(record).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return Object.fromEntries(entries);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parsePreviewState(value: unknown): PreviewState {
  const record = toRecord(value);
  if (!record) {
    return {};
  }
  return {
    scenarioId: readString(record.scenarioId),
    themeName: readString(record.themeName),
    expandedPreview:
      typeof record.expandedPreview === "boolean" ? record.expandedPreview : undefined,
    animationPaused:
      typeof record.animationPaused === "boolean" ? record.animationPaused : undefined,
  };
}

function parseThemeSpec(value: unknown): ThemeSpec {
  const record = toRecord(value);
  return {
    name: readString(record?.name),
    vars: toStringMap(record?.vars),
    colors: toStringMap(record?.colors),
  };
}

function isPreviewScenariosModule(value: unknown): value is PreviewScenariosModule {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = toRecord(value);
  if (!record) {
    return false;
  }
  return (
    typeof record.getToolPreviewScenarios === "function" &&
    typeof record.getToolPreviewPanels === "function" &&
    typeof record.createPreviewComponent === "function" &&
    typeof record.resolvePreviewResult === "function"
  );
}

export type {
  PreviewPanel,
  PreviewPanelEntry,
  PreviewScenario,
  PreviewScenariosModule,
  PreviewState,
  PreviewThemeRegistry,
  ThemeSpec,
};
export { isPreviewScenariosModule, parsePreviewState, parseThemeSpec };
