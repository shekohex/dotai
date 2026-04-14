import { Theme, initTheme } from "@mariozechner/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  ProcessTerminal,
  setKeybindings,
  Spacer,
  Text,
  TUI,
} from "@mariozechner/pi-tui";
import { existsSync, readdirSync, readFileSync, watch } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultSettings } from "../src/default-settings.js";
import { KeybindingsManager } from "../node_modules/@mariozechner/pi-coding-agent/dist/core/keybindings.js";
import { setThemeInstance } from "../node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.js";

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

type PreviewPanelEntry = {
  scenario: PreviewScenario;
  panel: PreviewScenariosModule["getToolPreviewPanels"] extends (scenario: any) => Array<infer T>
    ? T
    : never;
  component: ReturnType<PreviewScenariosModule["createPreviewComponent"]>;
};

type ThemeSpec = {
  name?: string;
  vars?: Record<string, string>;
  colors: Record<string, string>;
};

const THEME_BACKGROUND_KEYS = new Set([
  "selectedBg",
  "userMessageBg",
  "customMessageBg",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
]);
const PREVIEW_STATE_PATH = resolve(".tmp/tool-preview/state.json");

class ToolPreviewApp extends Container {
  private scenarioIndex = 0;
  private themeIndex: number;
  private previewModule: PreviewScenariosModule;
  private scenarios: PreviewScenario[];
  private expandedPreview = false;
  private animationPaused = false;
  private animationElapsedMs = 0;
  private animationInterval?: NodeJS.Timeout;
  private panelEntries: PreviewPanelEntry[] = [];

  constructor(
    private readonly tui: TUI,
    previewModule: PreviewScenariosModule,
    scenarios: PreviewScenario[],
    private themeRegistry: PreviewThemeRegistry,
    initialState: PreviewState,
    private readonly onStateChange: (state: PreviewState) => void,
  ) {
    super();
    this.previewModule = previewModule;
    this.scenarios = scenarios;
    const themeNames = this.themeRegistry.names;
    const configuredTheme = String(initialState.themeName ?? defaultSettings.theme ?? "dark");
    const configuredThemeIndex = themeNames.indexOf(configuredTheme);
    this.themeIndex = configuredThemeIndex >= 0 ? configuredThemeIndex : 0;
    if (initialState.scenarioId) {
      const scenarioIndex = this.scenarios.findIndex(
        (scenario) => scenario.id === initialState.scenarioId,
      );
      this.scenarioIndex = scenarioIndex >= 0 ? scenarioIndex : 0;
    }
    this.expandedPreview = initialState.expandedPreview ?? false;
    this.animationPaused = initialState.animationPaused ?? false;
    this.themeRegistry.apply(this.themeName);
    this.rebuild();
    this.startAnimationLoop();
    this.persistState();
  }

  private get themeName(): string {
    return this.themeRegistry.names[this.themeIndex] ?? "dark";
  }

  setThemeRegistry(themeRegistry: PreviewThemeRegistry): void {
    const currentTheme = this.themeName;
    this.themeRegistry = themeRegistry;
    const nextIndex = this.themeRegistry.names.indexOf(currentTheme);
    this.themeIndex = nextIndex >= 0 ? nextIndex : 0;
    this.themeRegistry.apply(this.themeName);
    this.rebuild();
    this.tui.requestRender();
    this.persistState();
  }

  setPreviewData(previewModule: PreviewScenariosModule, scenarios: PreviewScenario[]): void {
    const currentScenarioId = this.scenarios[this.scenarioIndex]?.id;
    const previousScenarioId = currentScenarioId;
    this.previewModule = previewModule;
    this.scenarios = scenarios;

    if (this.scenarios.length === 0) {
      this.scenarioIndex = 0;
    } else if (currentScenarioId) {
      const nextIndex = this.scenarios.findIndex((scenario) => scenario.id === currentScenarioId);
      this.scenarioIndex =
        nextIndex >= 0 ? nextIndex : Math.min(this.scenarioIndex, this.scenarios.length - 1);
    } else {
      this.scenarioIndex = Math.min(this.scenarioIndex, this.scenarios.length - 1);
    }

    if (this.scenarios[this.scenarioIndex]?.id !== previousScenarioId) {
      this.animationElapsedMs = 0;
    }

    this.rebuild();
    this.tui.requestRender();
    this.persistState();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.left) || matchesKey(data, Key.up) || data === "k" || data === "h") {
      this.scenarioIndex = (this.scenarioIndex + this.scenarios.length - 1) % this.scenarios.length;
      this.animationElapsedMs = 0;
      this.rebuild();
      this.tui.requestRender();
      this.persistState();
      return;
    }

    if (matchesKey(data, Key.right) || matchesKey(data, Key.down) || data === "j" || data === "l") {
      this.scenarioIndex = (this.scenarioIndex + 1) % this.scenarios.length;
      this.animationElapsedMs = 0;
      this.rebuild();
      this.tui.requestRender();
      this.persistState();
      return;
    }

    if (data === "t") {
      this.themeIndex = (this.themeIndex + 1) % this.themeRegistry.names.length;
      this.themeRegistry.apply(this.themeName);
      this.rebuild();
      this.tui.requestRender();
      this.persistState();
      return;
    }

    if (data === "T") {
      this.themeIndex =
        (this.themeIndex + this.themeRegistry.names.length - 1) % this.themeRegistry.names.length;
      this.themeRegistry.apply(this.themeName);
      this.rebuild();
      this.tui.requestRender();
      this.persistState();
      return;
    }

    if (data === "q" || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.tui.stop();
      process.exit(0);
    }

    if (matchesKey(data, Key.ctrl("o"))) {
      this.expandedPreview = !this.expandedPreview;
      this.rebuild();
      this.tui.requestRender();
      this.persistState();
      return;
    }

    if (data === " ") {
      this.animationPaused = !this.animationPaused;
      this.persistState();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.ctrl("d"))) {
      this.tui.stop();
      process.exit(0);
    }
  }

  private rebuild(): void {
    this.clear();
    this.panelEntries = [];

    if (this.scenarios.length === 0) {
      this.addChild(new Text("No preview scenarios matched", 1, 0));
      return;
    }

    const scenario = this.scenarios[this.scenarioIndex];
    const panels = this.previewModule
      .getToolPreviewPanels(scenario)
      .filter(
        (panel) => !this.expandedPreview || panel.id.endsWith("expanded") || panel.id === "error",
      );

    this.addChild(
      new Text(
        [
          `Tool preview ${this.scenarioIndex + 1}/${this.scenarios.length} · ${scenario.id} · theme=${this.themeName} · expanded=${this.expandedPreview ? "on" : "off"}`,
          scenario.title,
          `←/→ or j/k switch · ctrl+o toggle expanded preview · space pause animation · t/T cycle theme · q quit · themes=${this.themeRegistry.names.join(", ")}`,
        ].join("\n"),
        1,
        0,
      ),
    );

    for (const panel of panels) {
      this.addChild(new Spacer(1));
      this.addChild(new Text(panel.label, 1, 0));
      const component = this.previewModule.createPreviewComponent(
        scenario,
        panel,
        this.tui,
        this.animationElapsedMs,
      );
      this.panelEntries.push({ scenario, panel, component });
      this.addChild(component);
    }
  }

  private persistState(): void {
    this.onStateChange({
      scenarioId: this.scenarios[this.scenarioIndex]?.id,
      themeName: this.themeName,
      expandedPreview: this.expandedPreview,
      animationPaused: this.animationPaused,
    });
  }

  private startAnimationLoop(): void {
    this.animationInterval = setInterval(() => {
      if (this.animationPaused) {
        return;
      }

      this.animationElapsedMs += 1000;
      for (const entry of this.panelEntries) {
        const result = this.previewModule.resolvePreviewResult(
          entry.scenario,
          entry.panel,
          this.animationElapsedMs,
        );
        if (!result || !entry.panel.isPartial) {
          continue;
        }

        entry.component.updateResult(
          {
            content: result.content,
            details: result.details,
            isError: entry.panel.isError ?? false,
          },
          true,
        );
      }
      this.tui.requestRender();
    }, 1000);
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const shouldList = args.includes("--list");
  const shouldWatch = args.includes("--watch");
  const filters = args.filter((arg) => arg !== "--list" && arg !== "--watch");
  return { shouldList, shouldWatch, query: filters.join(" ").trim().toLowerCase() };
}

function createThemeRegistry(): PreviewThemeRegistry {
  const localThemesDir = resolve("src/resources/themes");
  const customThemes = new Map<string, Theme>();

  if (existsSync(localThemesDir)) {
    for (const entry of readdirSync(localThemesDir)) {
      if (!entry.endsWith(".json")) {
        continue;
      }

      const sourcePath = join(localThemesDir, entry);
      const theme = loadThemeFromFile(sourcePath);
      if (theme.name) {
        customThemes.set(theme.name, theme);
      }
    }
  }

  const names = ["dark", "light", ...customThemes.keys()];
  return {
    names,
    apply: (name: string) => {
      const customTheme = customThemes.get(name);
      if (customTheme) {
        setThemeInstance(customTheme);
        return;
      }

      initTheme(name);
    },
  };
}

function watchLocalThemes(onChange: () => void): void {
  const localThemesDir = resolve("src/resources/themes");
  if (!existsSync(localThemesDir)) {
    return;
  }

  watch(localThemesDir, { persistent: true }, (_eventType, filename) => {
    if (!filename || !filename.endsWith(".json")) {
      return;
    }

    onChange();
  });
}

function watchPreviewSources(onChange: () => void): void {
  const roots = [resolve("src"), resolve("test")];

  for (const root of roots) {
    if (!existsSync(root)) {
      continue;
    }

    try {
      watch(root, { persistent: true, recursive: true }, (_eventType, filename) => {
        if (
          !filename ||
          (!filename.endsWith(".ts") && !filename.endsWith(".tsx") && !filename.endsWith(".json"))
        ) {
          return;
        }

        onChange();
      });
    } catch {
      watch(root, { persistent: true }, (_eventType, filename) => {
        if (
          !filename ||
          (!filename.endsWith(".ts") && !filename.endsWith(".tsx") && !filename.endsWith(".json"))
        ) {
          return;
        }

        onChange();
      });
    }
  }
}

async function loadPreviewScenariosModule(): Promise<PreviewScenariosModule> {
  const moduleUrl = pathToFileURL(resolve("test/tool-preview-scenarios.ts")).href;
  return import(`${moduleUrl}?ts=${Date.now()}`);
}

async function loadPreviewState(): Promise<PreviewState> {
  try {
    const content = await readFile(PREVIEW_STATE_PATH, "utf8");
    const parsed = JSON.parse(content) as PreviewState;
    return parsed ?? {};
  } catch {
    return {};
  }
}

async function savePreviewState(state: PreviewState): Promise<void> {
  await mkdir(resolve(".tmp/tool-preview"), { recursive: true });
  await writeFile(PREVIEW_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function filterScenarios(previewModule: PreviewScenariosModule, query: string): PreviewScenario[] {
  return previewModule.getToolPreviewScenarios().filter((scenario) => {
    if (!query) {
      return true;
    }

    const haystack = `${scenario.id} ${scenario.title} ${scenario.toolName}`.toLowerCase();
    return haystack.includes(query);
  });
}

function loadThemeFromFile(filePath: string): Theme {
  const spec = JSON.parse(readFileSync(filePath, "utf8")) as ThemeSpec;
  const vars = spec.vars ?? {};
  const fgColors: Record<string, string> = {};
  const bgColors: Record<string, string> = {};

  for (const [key, value] of Object.entries(spec.colors ?? {})) {
    const resolved = resolveThemeColor(value, vars);
    if (THEME_BACKGROUND_KEYS.has(key)) {
      bgColors[key] = resolved;
    } else {
      fgColors[key] = resolved;
    }
  }

  return new Theme(fgColors, bgColors, "truecolor", {
    name: spec.name,
    sourcePath: filePath,
  });
}

function resolveThemeColor(value: string, vars: Record<string, string>): string {
  return vars[value] ?? value;
}

async function main() {
  const { shouldList, shouldWatch, query } = parseArgs();
  const themeRegistry = createThemeRegistry();
  const persistedState = await loadPreviewState();
  let previewModule = await loadPreviewScenariosModule();
  let scenarios = filterScenarios(previewModule, query);

  if (shouldList) {
    for (const scenario of scenarios) {
      process.stdout.write(`${scenario.id}\n`);
    }
    return;
  }

  if (scenarios.length === 0) {
    process.stderr.write(`No preview scenarios matched${query ? `: ${query}` : ""}\n`);
    process.exit(1);
  }

  setKeybindings(KeybindingsManager.create());
  const tui = new TUI(new ProcessTerminal());
  let stateWrite: Promise<void> = Promise.resolve();
  const app = new ToolPreviewApp(
    tui,
    previewModule,
    scenarios,
    themeRegistry,
    persistedState,
    (state) => {
      stateWrite = stateWrite.then(() => savePreviewState(state)).catch(() => undefined);
    },
  );
  const shutdown = () => {
    tui.stop();
    process.exit(0);
  };

  let reloadTimer: NodeJS.Timeout | undefined;
  const scheduleReload = () => {
    if (reloadTimer) {
      clearTimeout(reloadTimer);
    }

    reloadTimer = setTimeout(async () => {
      try {
        const nextPreviewModule = await loadPreviewScenariosModule();
        const nextScenarios = filterScenarios(nextPreviewModule, query);
        previewModule = nextPreviewModule;
        scenarios = nextScenarios;
        app.setPreviewData(nextPreviewModule, nextScenarios);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        app.setPreviewData(previewModule, scenarios);
        app.addChild(new Spacer(1));
        app.addChild(new Text(`Reload failed: ${message}`, 1, 0));
        tui.requestRender();
      }
    }, 80);
  };

  process.once("SIGINT", shutdown);
  process.stdin.once("end", shutdown);
  tui.addChild(app);
  tui.setFocus(app);
  watchLocalThemes(() => {
    app.setThemeRegistry(createThemeRegistry());
  });
  if (shouldWatch) {
    watchPreviewSources(scheduleReload);
  }
  tui.start();
}

void main();
