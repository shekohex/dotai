import type { ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Key, Text, matchesKey, type Component, type TUI } from "@mariozechner/pi-tui";
import { loadBundledDoc } from "./resources.js";

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

class GsdHelpComponent implements Component {
  private readonly container = new Container();
  private readonly body = new Text("");
  private docIndex = 0;

  constructor(
    private readonly theme: Theme,
    private readonly done: () => void,
  ) {
    this.container.addChild(new DynamicBorder((s) => this.theme.fg("accent", s)));
    this.container.addChild(new Text(this.theme.bold(this.theme.fg("accent", "GSD"))));
    this.container.addChild(this.body);
    this.container.addChild(new DynamicBorder((s) => this.theme.fg("accent", s)));
    this.refresh();
  }

  private refresh(): void {
    this.body.setText(
      [
        "/gsd on",
        "/gsd off",
        "/gsd new-project",
        "/gsd map-codebase",
        "/gsd discuss-phase",
        "/gsd plan-phase",
        "/gsd execute-phase",
        "/gsd verify-work",
        "/gsd validate-phase",
        "/gsd next",
        "/gsd progress",
        "/gsd stats",
        "/gsd health",
        "/gsd status",
        "",
        `Docs (${this.docIndex + 1}/${bundledDocs.length})`,
        ...bundledDocs.map((name, index) => `${index === this.docIndex ? ">" : " "} ${name}`),
        "",
        loadBundledDoc(bundledDocs[this.docIndex]).split("\n").slice(0, 12).join("\n"),
      ].join("\n"),
    );
    this.container.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "return") || data === "q") {
      this.done();
      return;
    }
    if (matchesKey(data, Key.down) || data.toLowerCase() === "j") {
      this.docIndex = (this.docIndex + 1) % bundledDocs.length;
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.up) || data.toLowerCase() === "k") {
      this.docIndex = (this.docIndex - 1 + bundledDocs.length) % bundledDocs.length;
      this.refresh();
    }
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  invalidate(): void {
    this.container.invalidate();
  }

  dispose(): void {}
}

export async function showGsdHelp(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify(
      `GSD: /gsd [on|off|new-project|map-codebase|discuss-phase|plan-phase|execute-phase|verify-work|validate-phase|next|progress|stats|health|status|help]\n${loadBundledDoc("command-reference.md").split("\n").slice(0, 8).join("\n")}`,
      "info",
    );
    return;
  }

  await ctx.ui.custom<void>(
    (_tui: TUI, theme, _kb, done) =>
      new GsdHelpComponent(theme, () => {
        done();
      }),
  );
}
