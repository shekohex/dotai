import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Key, Text, matchesKey, type Component, type TUI } from "@mariozechner/pi-tui";
import { loadBundledDoc } from "./resources.js";

const HELP_PAGE_LINES = 20;

export function getGsdHelpReference(): string {
  return loadBundledDoc("command-reference.md");
}

class GsdHelpComponent implements Component {
  private readonly body = new Text(getGsdHelpReference());
  private offset = 0;
  private renderWidth = 100;

  constructor(
    private readonly done: () => void,
    private readonly requestRender: () => void,
  ) {}

  render(width: number): string[] {
    this.renderWidth = width;
    const lines = this.body.render(width);
    const totalLines = lines.length;
    const maxOffset = Math.max(0, totalLines - HELP_PAGE_LINES);
    this.offset = Math.min(this.offset, maxOffset);
    const end = Math.min(this.offset + HELP_PAGE_LINES, totalLines);
    const footer = `[${this.offset + 1}-${end}/${totalLines}] ↑↓ scroll PgUp/PgDn page Enter/Esc/q close`;
    return [...lines.slice(this.offset, end), "", footer];
  }

  invalidate(): void {
    this.body.invalidate();
  }

  handleInput(data: string): void {
    const maxOffset = Math.max(0, this.body.render(this.renderWidth).length - HELP_PAGE_LINES);

    if (data === "\u001B[A" || data.toLowerCase() === "k") {
      this.offset = Math.max(0, this.offset - 1);
      this.requestRender();
      return;
    }

    if (data === "\u001B[B" || data.toLowerCase() === "j") {
      this.offset = Math.min(maxOffset, this.offset + 1);
      this.requestRender();
      return;
    }

    if (matchesKey(data, Key.pageUp)) {
      this.offset = Math.max(0, this.offset - HELP_PAGE_LINES);
      this.requestRender();
      return;
    }

    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.space)) {
      this.offset = Math.min(maxOffset, this.offset + HELP_PAGE_LINES);
      this.requestRender();
      return;
    }

    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.return) ||
      data.toLowerCase() === "q"
    ) {
      this.done();
    }
  }

  dispose(): void {}
}

export async function showGsdHelp(
  pi: Pick<ExtensionAPI, "sendMessage">,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const reference = getGsdHelpReference();

  if (!ctx.hasUI) {
    pi.sendMessage(
      {
        customType: "gsd-help",
        content: reference,
        display: true,
      },
      { triggerTurn: false },
    );
    return;
  }

  await ctx.ui.custom<void>((tui: TUI, _theme, _kb, done) => {
    return new GsdHelpComponent(done, () => {
      tui.requestRender();
    });
  });
}

export function createGsdHelpComponent(done: () => void): Component {
  return new GsdHelpComponent(done, () => {});
}
