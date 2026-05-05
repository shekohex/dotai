import { getSettingsListTheme, type Theme } from "@mariozechner/pi-coding-agent";
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
  Container,
  Key,
  SettingsList,
  Text,
  matchesKey,
  type Component,
  type SettingItem,
  type TUI,
} from "@mariozechner/pi-tui";
import { loadBundledDoc } from "./resources.js";
import { getGsdSettings, saveGsdSettings } from "./settings.js";
import { computeHealth } from "./state/health.js";
import { computeProgress } from "./state/progress.js";
import { readPlanningSnapshot } from "./state/read.js";
import { readRoadmapPhases } from "./state/roadmap.js";
import { computeStats } from "./state/stats.js";

const bundledDocs = [
  "overview.md",
  "architecture.md",
  "user-guide.md",
  "command-reference.md",
  "role-reference.md",
  "compatibility.md",
  "checklist.md",
  "audit.md",
] as const;

class GsdDashboard implements Component {
  private readonly container = new Container();
  private readonly summary = new Text("");
  private readonly details = new Text("");
  private readonly docs = new Text("");
  private readonly settings: SettingsList;
  private docIndex = 0;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly ctx: ExtensionCommandContext,
    private readonly done: () => void,
  ) {
    const items: SettingItem[] = [
      {
        id: "enabled",
        label: "enabled",
        currentValue: getGsdSettings(ctx.cwd).enabled ? "on" : "off",
        values: ["on", "off"],
      },
    ];
    this.settings = new SettingsList(
      items,
      4,
      getSettingsListTheme(),
      (id, newValue) => {
        if (id !== "enabled") {
          return;
        }
        saveGsdSettings(ctx.cwd, { enabled: newValue === "on" });
        this.refreshSummary();
      },
      () => {
        this.done();
      },
    );
    this.container.addChild(new Text(this.theme.fg("accent", this.theme.bold("GSD"))));
    this.container.addChild(new Text(this.theme.fg("dim", "Esc/q close")));
    this.container.addChild(new Text(""));
    this.container.addChild(this.summary);
    this.container.addChild(new Text(""));
    this.container.addChild(this.details);
    this.container.addChild(new Text(""));
    this.container.addChild(this.settings);
    this.container.addChild(new Text(""));
    this.container.addChild(this.docs);
    this.refreshSummary();
  }

  private refreshSummary(): void {
    const settings = getGsdSettings(this.ctx.cwd);
    const progress = computeProgress(this.ctx.cwd);
    const stats = computeStats(this.ctx.cwd);
    const health = computeHealth(this.ctx.cwd);
    const phases = readRoadmapPhases(this.ctx.cwd);
    const snapshot = readPlanningSnapshot(this.ctx.cwd);
    const activePhase =
      snapshot.phases.find(
        (phase) =>
          phase.id ===
          `${progress.currentPhase ?? ""}-${(progress.currentPhaseName ?? "")
            .trim()
            .toLowerCase()
            .replaceAll(/[^a-z0-9]+/g, "-")}`,
      ) ??
      snapshot.phases.find(
        (phase) => phase.name === (progress.currentPhaseName ?? "").trim().toLowerCase(),
      ) ??
      snapshot.phases[0];
    const recentArtifacts =
      activePhase === undefined
        ? []
        : [
            ...activePhase.plans.map((plan) => plan.fileName),
            ...activePhase.summaries,
            ...activePhase.validations,
            ...activePhase.uats,
          ].slice(0, 6);
    this.summary.setText(
      [
        `Enabled: ${settings.enabled ? "on" : "off"}`,
        `Progress: ${progress.bar} ${progress.percent}%`,
        `Current: ${progress.currentPhase ?? "-"} ${progress.currentPhaseName ?? ""}`.trim(),
        `Goals: ${snapshot.goals.length}  Milestones: ${snapshot.milestones.length}  Phases: ${phases.length}`,
        `Plans: ${stats.planCount}`,
        `Summaries: ${stats.summaryCount}`,
        `Pending Todos: ${snapshot.pendingTodos.length}`,
        `Health: ${health.healthy ? "ok" : `${health.issues.length} issues`}`,
      ].join("\n"),
    );
    this.details.setText(
      [
        "Current Phase",
        `${progress.currentPhase ?? "-"} ${progress.currentPhaseName ?? "-"}`.trim(),
        `Plan: ${progress.currentPlan ?? "-"}`,
        `Status: ${progress.status}`,
        "",
        "Health Issues",
        ...(health.issues.length === 0
          ? ["None"]
          : health.issues.slice(0, 5).map((issue) => `${issue.severity}: ${issue.file}`)),
        "",
        "Recent Artifacts",
        ...(recentArtifacts.length === 0 ? ["None"] : recentArtifacts),
        "",
        "Milestones",
        ...(snapshot.milestones.length === 0 ? ["None"] : snapshot.milestones.slice(0, 5)),
        "",
        "Goals",
        ...(snapshot.goals.length === 0 ? ["None"] : snapshot.goals.slice(0, 5)),
        "",
        "Pending Todos",
        ...(snapshot.pendingTodos.length === 0 ? ["None"] : snapshot.pendingTodos.slice(0, 5)),
      ].join("\n"),
    );
    this.docs.setText(
      [
        `Docs (${this.docIndex + 1}/${bundledDocs.length})`,
        ...bundledDocs.map((name, index) => `${index === this.docIndex ? ">" : " "} ${name}`),
        "",
        loadBundledDoc(bundledDocs[this.docIndex]).split("\n").slice(0, 12).join("\n"),
      ].join("\n"),
    );
    this.container.invalidate();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  invalidate(): void {
    this.container.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data.toLowerCase() === "q") {
      this.done();
      return;
    }
    if (matchesKey(data, Key.down) || data.toLowerCase() === "j") {
      this.docIndex = (this.docIndex + 1) % bundledDocs.length;
      this.refreshSummary();
      return;
    }
    if (matchesKey(data, Key.up) || data.toLowerCase() === "k") {
      this.docIndex = (this.docIndex - 1 + bundledDocs.length) % bundledDocs.length;
      this.refreshSummary();
      return;
    }
    this.settings.handleInput?.(data);
    this.tui.requestRender();
  }

  dispose(): void {}
}

export async function showGsdDashboard(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    const settings = getGsdSettings(ctx.cwd);
    const progress = computeProgress(ctx.cwd);
    const snapshot = readPlanningSnapshot(ctx.cwd);
    ctx.ui.notify(
      `GSD enabled=${settings.enabled} progress=${progress.percent}% phase=${progress.currentPhase ?? "-"} goals=${snapshot.goals.length} milestones=${snapshot.milestones.length} todos=${snapshot.pendingTodos.length}`,
      "info",
    );
    return;
  }
  await ctx.ui.custom<void>((tui, theme, _kb, done) => new GsdDashboard(tui, theme, ctx, done));
}
