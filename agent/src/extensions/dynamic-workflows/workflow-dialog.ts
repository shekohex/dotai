import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  Text,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";

export interface WorkflowDialogOptions {
  getTitle: () => string;
  helpText: () => string;
  renderBody: (innerWidth: number) => string[];
  onKey: (data: string) => boolean;
}

export class WorkflowDialog extends Container implements Focusable {
  private readonly titleText: Text;
  private readonly summaryText: Text;
  private readonly body: Container;
  private readonly helpText: Text;
  private bodyLines: string[] = [];
  private scrollOffset = 0;
  private viewportHeight = 8;
  private titleTextValue = "";
  private summaryTextValue = "";
  private helpTextValue = "";
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
  }

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly options: WorkflowDialogOptions,
    private readonly onClose: () => void,
  ) {
    super();
    this.titleText = new Text("", 1, 0);
    this.summaryText = new Text("", 1, 0);
    this.body = new Container();
    this.helpText = new Text("", 1, 0);
    this.refresh();
  }

  private frameLine(content: string, innerWidth: number): string {
    const truncated = truncateToWidth(content, innerWidth, "");
    const padding = Math.max(0, innerWidth - visibleWidth(truncated));
    return `${this.theme.fg("borderMuted", "│")}${truncated}${" ".repeat(padding)}${this.theme.fg("borderMuted", "│")}`;
  }

  private ruleLine(innerWidth: number): string {
    return this.theme.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`);
  }

  private borderLine(innerWidth: number, edge: "top" | "bottom"): string {
    const left = edge === "top" ? "┌" : "└";
    const right = edge === "top" ? "┐" : "┘";
    return this.theme.fg("borderMuted", `${left}${"─".repeat(innerWidth)}${right}`);
  }

  private wrapBody(innerWidth: number): string[] {
    const wrapped: string[] = [];
    for (const line of this.bodyLines) {
      if (line === "") {
        wrapped.push("");
        continue;
      }
      wrapped.push(...wrapTextWithAnsi(line, Math.max(1, innerWidth)));
    }
    return wrapped;
  }

  private getDialogHeight(): number {
    const terminalRows = this.tui.terminal?.rows ?? process.stdout.rows ?? 30;
    return Math.max(20, Math.min(38, Math.floor(terminalRows * 0.88)));
  }

  private scrollBy(delta: number): void {
    this.scrollOffset = Math.max(0, this.scrollOffset + delta);
    this.tui.requestRender();
  }

  dispose(): void {
    this.body.clear();
  }

  handleInput(data: string): void {
    if (this.options.onKey(data)) {
      this.scrollOffset = 0;
      this.refresh();
      return;
    }

    if (matchesKey(data, Key.escape) || data === "q") {
      this.onClose();
      return;
    }

    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.up)) {
      const step = matchesKey(data, Key.pageUp) ? Math.max(1, this.viewportHeight - 1) : 1;
      this.scrollBy(-step);
      return;
    }

    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.down)) {
      const step = matchesKey(data, Key.pageDown) ? Math.max(1, this.viewportHeight - 1) : 1;
      this.scrollBy(step);
      return;
    }

    if (matchesKey(data, Key.home)) {
      this.scrollOffset = 0;
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.end)) {
      this.scrollOffset = Number.MAX_SAFE_INTEGER;
      this.tui.requestRender();
    }
  }

  override render(width: number): string[] {
    const dialogWidth = Math.max(24, width);
    const innerWidth = Math.max(22, dialogWidth - 2);
    const bodyLines = this.wrapBody(innerWidth);
    const dialogHeight = this.getDialogHeight();
    const chromeHeight = 7;
    const bodyHeight = Math.max(6, dialogHeight - chromeHeight);
    this.viewportHeight = bodyHeight;

    const maxScroll = Math.max(0, bodyLines.length - bodyHeight);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
    const visibleBody = bodyLines.slice(this.scrollOffset, this.scrollOffset + bodyHeight);
    const bodyPadCount = Math.max(0, bodyHeight - visibleBody.length);
    const hiddenAbove = this.scrollOffset;
    const hiddenBelow = Math.max(0, maxScroll - this.scrollOffset);
    const summary =
      hiddenAbove || hiddenBelow
        ? `${this.summaryTextValue.trim()} · ↑${hiddenAbove} ↓${hiddenBelow}`
        : this.summaryTextValue.trim();

    const lines = [
      this.borderLine(innerWidth, "top"),
      this.frameLine(
        this.theme.fg("accent", this.theme.bold(this.titleTextValue.trim())),
        innerWidth,
      ),
      this.frameLine(this.theme.fg("dim", summary), innerWidth),
      this.ruleLine(innerWidth),
    ];

    for (const line of visibleBody) {
      lines.push(this.frameLine(line, innerWidth));
    }
    for (let index = 0; index < bodyPadCount; index += 1) {
      lines.push(this.frameLine("", innerWidth));
    }

    lines.push(this.ruleLine(innerWidth));
    lines.push(this.frameLine(this.theme.fg("dim", this.helpTextValue.trim()), innerWidth));
    lines.push(this.borderLine(innerWidth, "bottom"));

    return lines;
  }

  refresh(): void {
    this.titleTextValue = this.options.getTitle();
    this.titleText.setText(this.titleTextValue);
    this.helpTextValue = this.options.helpText();
    this.helpText.setText(this.helpTextValue);

    const innerWidth = Math.max(
      22,
      Math.floor((this.tui.terminal?.columns ?? process.stdout.columns ?? 80) * 0.78) - 2,
    );
    this.bodyLines = this.options.renderBody(innerWidth);
    this.summaryTextValue = `${this.bodyLines.length} line${this.bodyLines.length === 1 ? "" : "s"}`;
    this.summaryText.setText(this.summaryTextValue);
    this.body.clear();
    for (const line of this.bodyLines) {
      this.body.addChild(new Text(line, 1, 0));
    }
    this.tui.requestRender();
  }
}
