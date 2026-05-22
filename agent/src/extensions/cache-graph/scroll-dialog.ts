import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

const DEFAULT_DIALOG_BODY_ROWS = Math.max(10, Math.min(28, (process.stdout.rows ?? 30) - 10));

function repeat(char: string, count: number): string {
  return count > 0 ? char.repeat(count) : "";
}

function fitLine(content: string, width: number): string {
  const trimmed = truncateToWidth(content, width, "…");
  const pad = Math.max(0, width - visibleWidth(trimmed));
  return trimmed + repeat(" ", pad);
}

export interface ScrollDialogOptions {
  title: string;
  /** If provided, called at render time and takes precedence over `title`. */
  getTitle?: () => string;
  helpText?: string;
  width?: number;
  maxBodyRows?: number;
  renderBody: (innerWidth: number) => string[];
  /**
   * Called before default scroll/close handling. Return `true` if the key was consumed — the dialog
   * will invalidate and re-render. Return `false` to fall through to default handling.
   */
  onKey?: (data: string) => boolean;
}

export class ScrollDialog implements Component {
  private scrollOffset = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    private readonly theme: Theme,
    private readonly options: ScrollDialogOptions,
    private readonly onClose: () => void,
  ) {}

  handleInput(data: string): void {
    const pageSize = Math.max(1, (this.options.maxBodyRows ?? DEFAULT_DIALOG_BODY_ROWS) - 2);

    if (this.options.onKey) {
      const handled = this.options.onKey(data);
      if (handled) {
        this.invalidate();
        return;
      }
    }

    if (matchesKey(data, Key.escape) || data === "q") {
      this.onClose();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.scrollOffset += 1;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - pageSize);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollOffset += pageSize;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.home)) {
      this.scrollOffset = 0;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.scrollOffset = Number.MAX_SAFE_INTEGER;
      this.invalidate();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const dialogWidth = Math.max(40, Math.min(this.options.width ?? width, width));
    const innerWidth = dialogWidth - 2;
    const maxBodyRows = this.options.maxBodyRows ?? DEFAULT_DIALOG_BODY_ROWS;
    const bodyLines = this.options.renderBody(Math.max(10, innerWidth));
    const maxScrollOffset = Math.max(0, bodyLines.length - maxBodyRows);
    const scrollOffset = Math.min(this.scrollOffset, maxScrollOffset);
    this.scrollOffset = scrollOffset;

    const visibleBodyLines = bodyLines.slice(scrollOffset, scrollOffset + maxBodyRows);
    const lines: string[] = [];

    const topBorder = this.theme.fg("borderAccent", `╭${repeat("─", innerWidth)}╮`);
    const bottomBorder = this.theme.fg("borderAccent", `╰${repeat("─", innerWidth)}╯`);
    const border = this.theme.fg("border", "│");

    const resolvedTitle = this.options.getTitle ? this.options.getTitle() : this.options.title;
    const title = this.theme.fg("accent", this.theme.bold(` ${resolvedTitle} `));
    const titleSuffix =
      bodyLines.length > maxBodyRows
        ? this.theme.fg(
            "dim",
            ` ${scrollOffset + 1}-${Math.min(scrollOffset + visibleBodyLines.length, bodyLines.length)}/${bodyLines.length}`,
          )
        : "";

    lines.push(topBorder);
    lines.push(`${border}${fitLine(title + titleSuffix, innerWidth)}${border}`);
    lines.push(`${border}${fitLine("", innerWidth)}${border}`);

    for (const line of visibleBodyLines) {
      lines.push(`${border}${fitLine(line, innerWidth)}${border}`);
    }

    for (let i = visibleBodyLines.length; i < maxBodyRows; i += 1) {
      lines.push(`${border}${fitLine("", innerWidth)}${border}`);
    }

    lines.push(`${border}${fitLine("", innerWidth)}${border}`);

    const helpText =
      this.options.helpText ?? "↑/↓ scroll • PgUp/PgDn jump • Home/End • q/Esc close";
    lines.push(`${border}${fitLine(this.theme.fg("dim", helpText), innerWidth)}${border}`);
    lines.push(bottomBorder);

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
