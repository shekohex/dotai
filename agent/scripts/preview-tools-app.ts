import { defaultSettings } from "../src/default-settings.js";
import { Container, Key, matchesKey, Spacer, Text, type TUI } from "@mariozechner/pi-tui";
import type {
  PreviewPanelEntry,
  PreviewScenario,
  PreviewScenariosModule,
  PreviewState,
  PreviewThemeRegistry,
} from "./preview-tools-types.js";

export class ToolPreviewApp extends Container {
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
    const configuredTheme = initialState.themeName ?? defaultSettings.theme ?? "dark";
    const configuredThemeIndex = themeNames.indexOf(configuredTheme);
    this.themeIndex = Math.max(configuredThemeIndex, 0);
    if (initialState.scenarioId !== undefined && initialState.scenarioId.length > 0) {
      const scenarioIndex = this.scenarios.findIndex(
        (scenario) => scenario.id === initialState.scenarioId,
      );
      this.scenarioIndex = Math.max(scenarioIndex, 0);
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
    this.themeIndex = Math.max(nextIndex, 0);
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
    if (this.handleExitInput(data)) return;
    if (this.handleScenarioInput(data)) return;
    if (this.handleThemeInput(data)) return;
    this.handleToggleInput(data);
  }

  private handleExitInput(data: string): boolean {
    if (
      data === "q" ||
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("c")) ||
      matchesKey(data, Key.ctrl("d"))
    ) {
      this.tui.stop();
      process.exit(0);
    }
    return false;
  }

  private handleScenarioInput(data: string): boolean {
    if (matchesKey(data, Key.left) || matchesKey(data, Key.up) || data === "k" || data === "h") {
      this.updateScenarioIndex(this.scenarioIndex + this.scenarios.length - 1);
      return true;
    }
    if (matchesKey(data, Key.right) || matchesKey(data, Key.down) || data === "j" || data === "l") {
      this.updateScenarioIndex(this.scenarioIndex + 1);
      return true;
    }
    return false;
  }

  private updateScenarioIndex(nextIndex: number): void {
    this.scenarioIndex = nextIndex % this.scenarios.length;
    this.animationElapsedMs = 0;
    this.rebuild();
    this.tui.requestRender();
    this.persistState();
  }

  private handleThemeInput(data: string): boolean {
    if (data === "t") {
      this.updateThemeIndex(this.themeIndex + 1);
      return true;
    }
    if (data === "T") {
      this.updateThemeIndex(this.themeIndex + this.themeRegistry.names.length - 1);
      return true;
    }
    return false;
  }

  private updateThemeIndex(nextIndex: number): void {
    this.themeIndex = nextIndex % this.themeRegistry.names.length;
    this.themeRegistry.apply(this.themeName);
    this.rebuild();
    this.tui.requestRender();
    this.persistState();
  }

  private handleToggleInput(data: string): boolean {
    if (matchesKey(data, Key.ctrl("o"))) {
      this.expandedPreview = !this.expandedPreview;
      this.rebuild();
      this.tui.requestRender();
      this.persistState();
      return true;
    }
    if (data === " ") {
      this.animationPaused = !this.animationPaused;
      this.persistState();
      this.tui.requestRender();
      return true;
    }
    return false;
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
        if (result === undefined || result === null || entry.panel.isPartial !== true) {
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
