import { Theme, initTheme } from "@mariozechner/pi-coding-agent";
import { ProcessTerminal, Spacer, Text, TUI, setKeybindings } from "@mariozechner/pi-tui";
import { existsSync, readdirSync, readFileSync, watch } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { KeybindingsManager } from "../node_modules/@mariozechner/pi-coding-agent/dist/core/keybindings.js";
import { setThemeInstance } from "../node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { ToolPreviewApp } from "./preview-tools-app.js";
import {
  isPreviewScenariosModule,
  parsePreviewState,
  parseThemeSpec,
  type PreviewScenario,
  type PreviewScenariosModule,
  type PreviewState,
  type PreviewThemeRegistry,
} from "./preview-tools-types.js";

const THEME_BACKGROUND_KEYS = new Set([
  "selectedBg",
  "userMessageBg",
  "customMessageBg",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
]);
const PREVIEW_STATE_PATH = resolve(".tmp/tool-preview/state.json");

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
      if (theme.name !== undefined && theme.name.length > 0) {
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
    if (filename === undefined || filename === null || !filename.endsWith(".json")) {
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
    const onChangeEvent = (_eventType: string, filename: string | Buffer | null) => {
      if (
        filename === undefined ||
        filename === null ||
        (!filename.toString().endsWith(".ts") &&
          !filename.toString().endsWith(".tsx") &&
          !filename.toString().endsWith(".json"))
      ) {
        return;
      }
      onChange();
    };
    try {
      watch(root, { persistent: true, recursive: true }, onChangeEvent);
    } catch {
      watch(root, { persistent: true }, onChangeEvent);
    }
  }
}

async function loadPreviewScenariosModule(): Promise<PreviewScenariosModule> {
  const moduleUrl = pathToFileURL(resolve("test/tool-preview-scenarios.ts")).href;
  const module: unknown = await import(`${moduleUrl}?ts=${Date.now()}`);
  if (!isPreviewScenariosModule(module)) {
    throw new TypeError("Invalid preview scenarios module shape");
  }
  return module;
}

async function loadPreviewState(): Promise<PreviewState> {
  try {
    const content = await readFile(PREVIEW_STATE_PATH, "utf8");
    return parsePreviewState(JSON.parse(content));
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
  const spec = parseThemeSpec(JSON.parse(readFileSync(filePath, "utf8")));
  const vars = spec.vars ?? {};
  const fgColors: Record<string, string> = {};
  const bgColors: Record<string, string> = {};
  for (const [key, value] of Object.entries(spec.colors ?? {})) {
    const resolved = vars[value] ?? value;
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

function createPreviewRuntime(
  previewModule: PreviewScenariosModule,
  scenarios: PreviewScenario[],
  themeRegistry: PreviewThemeRegistry,
  persistedState: PreviewState,
): { tui: TUI; app: ToolPreviewApp; shutdown: () => void } {
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
      stateWrite = stateWrite.then(() => savePreviewState(state)).catch(() => {});
    },
  );
  const shutdown = () => {
    tui.stop();
    process.exit(0);
  };
  return { tui, app, shutdown };
}

function createReloadScheduler(
  tui: TUI,
  app: ToolPreviewApp,
  query: string,
  state: {
    getCurrentModule: () => PreviewScenariosModule;
    getCurrentScenarios: () => PreviewScenario[];
    setCurrent: (previewModule: PreviewScenariosModule, scenarios: PreviewScenario[]) => void;
  },
): () => void {
  let reloadTimer: NodeJS.Timeout | undefined;
  return () => {
    if (reloadTimer) {
      clearTimeout(reloadTimer);
    }
    reloadTimer = setTimeout(() => {
      void reloadPreviewScenarios(tui, app, query, state);
    }, 80);
  };
}

async function reloadPreviewScenarios(
  tui: TUI,
  app: ToolPreviewApp,
  query: string,
  state: {
    getCurrentModule: () => PreviewScenariosModule;
    getCurrentScenarios: () => PreviewScenario[];
    setCurrent: (previewModule: PreviewScenariosModule, scenarios: PreviewScenario[]) => void;
  },
): Promise<void> {
  try {
    const nextPreviewModule = await loadPreviewScenariosModule();
    const nextScenarios = filterScenarios(nextPreviewModule, query);
    state.setCurrent(nextPreviewModule, nextScenarios);
    app.setPreviewData(nextPreviewModule, nextScenarios);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    app.setPreviewData(state.getCurrentModule(), state.getCurrentScenarios());
    app.addChild(new Spacer(1));
    app.addChild(new Text(`Reload failed: ${message}`, 1, 0));
    tui.requestRender();
  }
}

async function main() {
  const { shouldList, shouldWatch, query } = parseArgs();
  const themeRegistry = createThemeRegistry();
  const persistedState = await loadPreviewState();
  let previewModule = await loadPreviewScenariosModule();
  let scenarios = filterScenarios(previewModule, query ?? "");

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

  const { tui, app, shutdown } = createPreviewRuntime(
    previewModule,
    scenarios,
    themeRegistry,
    persistedState,
  );
  const scheduleReload = createReloadScheduler(tui, app, query, {
    getCurrentModule: () => previewModule,
    getCurrentScenarios: () => scenarios,
    setCurrent: (nextModule, nextScenarios) => {
      previewModule = nextModule;
      scenarios = nextScenarios;
    },
  });

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

await main();
