import { type Component, truncateToWidth } from "@earendil-works/pi-tui";

/**
 * Single-row, width-clipped chrome cell. The footer row count is invariant
 * (`QuestionTabStrategy.footerRowCount = 4`) — pi-tui's `Text` word-wraps when the styled hint
 * exceeds `width`, inflating that row count and desyncing the `bodyHeight + footerRowCount` math in
 * `DialogView.render`. Clipping with `truncateToWidth` (ANSI-aware, matches `multi-select-view.ts`
 * usage) keeps the hint on one line; the collapse affordance falls off the right edge with `…` on
 * terminals too narrow to advertise it.
 */
export class OneLineClippedText implements Component {
  constructor(
    private readonly text: string,
    private readonly paddingLeft: number = 0,
  ) {}

  render(width: number): string[] {
    const pad = " ".repeat(this.paddingLeft);
    const avail = Math.max(0, width - this.paddingLeft);
    return [pad + truncateToWidth(this.text, avail, "…", false)];
  }

  invalidate(): void {}

  handleInput(_data: string): void {}
}
