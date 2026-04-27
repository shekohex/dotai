import { Theme, initTheme } from "@mariozechner/pi-coding-agent";
import { ProcessTerminal, Spacer, Text, TUI, setKeybindings } from "@mariozechner/pi-tui";
import { existsSync, readdirSync, readFileSync, watch } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { errorMessage } from "../src/utils/error-message.js";
import { KeybindingsManager } from "../node_modules/@mariozechner/pi-coding-agent/dist/core/keybindings.js";
import { setThemeInstance } from "../node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import * as previewScenariosModule from "../test/tool-preview-scenarios.ts";
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
  const isChildProcess = args.includes("--child-process");
  const filters = args.filter(
    (arg) => arg !== "--list" && arg !== "--watch" && arg !== "--child-process",
  );
  return {
    isChildProcess,
    shouldList,
    shouldWatch,
    query: filters.join(" ").trim().toLowerCase(),
    rawFilters: filters,
  };
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

function loadPreviewScenariosModule(): PreviewScenariosModule {
  const module = previewScenariosModule;
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
      reloadPreviewScenarios(tui, app, query, state);
    }, 80);
  };
}

function reloadPreviewScenarios(
  tui: TUI,
  app: ToolPreviewApp,
  query: string,
  state: {
    getCurrentModule: () => PreviewScenariosModule;
    getCurrentScenarios: () => PreviewScenario[];
    setCurrent: (previewModule: PreviewScenariosModule, scenarios: PreviewScenario[]) => void;
  },
): void {
  try {
    const nextPreviewModule = loadPreviewScenariosModule();
    const nextScenarios = filterScenarios(nextPreviewModule, query);
    state.setCurrent(nextPreviewModule, nextScenarios);
    app.setPreviewData(nextPreviewModule, nextScenarios);
  } catch (error) {
    const message = errorMessage(error);
    app.setPreviewData(state.getCurrentModule(), state.getCurrentScenarios());
    app.addChild(new Spacer(1));
    app.addChild(new Text(`Reload failed: ${message}`, 1, 0));
    tui.requestRender();
  }
}

function createChildArgs(filters: string[]): string[] {
  return ["--import", "tsx", "./scripts/preview-tools.ts", "--child-process", ...filters];
}

function runWatchSupervisor(filters: string[]): Promise<never> {
  let child = spawn(process.execPath, createChildArgs(filters), {
    cwd: process.cwd(),
    stdio: "inherit",
  });
  let restartTimer: NodeJS.Timeout | undefined;
  let childStoppingForRestart = false;

  const restartChild = () => {
    if (restartTimer) {
      clearTimeout(restartTimer);
    }
    restartTimer = setTimeout(() => {
      childStoppingForRestart = true;
      child.kill("SIGTERM");
    }, 80);
  };

  const startChild = () => {
    child = spawn(process.execPath, createChildArgs(filters), {
      cwd: process.cwd(),
      stdio: "inherit",
    });
    child.on("exit", (code, signal) => {
      if (childStoppingForRestart) {
        childStoppingForRestart = false;
        startChild();
        return;
      }
      if (signal === "SIGINT") {
        process.kill(process.pid, "SIGINT");
        return;
      }
      process.exit(code ?? 0);
    });
  };

  child.on("exit", (code, signal) => {
    if (childStoppingForRestart) {
      childStoppingForRestart = false;
      startChild();
      return;
    }
    if (signal === "SIGINT") {
      process.kill(process.pid, "SIGINT");
      return;
    }
    process.exit(code ?? 0);
  });

  watchLocalThemes(restartChild);
  watchPreviewSources(restartChild);

  process.once("SIGINT", () => child.kill("SIGINT"));
  process.once("SIGTERM", () => child.kill("SIGTERM"));

  return new Promise(() => {});
}

async function main() {
  const { isChildProcess, shouldList, shouldWatch, query, rawFilters } = parseArgs();
  if (shouldWatch && !isChildProcess) {
    await runWatchSupervisor(rawFilters);
    return;
  }
  const themeRegistry = createThemeRegistry();
  const persistedState = await loadPreviewState();
  let previewModule = loadPreviewScenariosModule();
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
  if (shouldWatch && isChildProcess) {
    watchPreviewSources(scheduleReload);
  }
  tui.start();
}

await main();
