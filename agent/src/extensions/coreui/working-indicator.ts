import type { ExtensionContext, WorkingIndicatorOptions } from "@mariozechner/pi-coding-agent";

const DOTS2_INTERVAL_MS = 80;
const DOTS2_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];
const PASTEL_COLORS = [
  "\u001B[38;2;255;179;186m",
  "\u001B[38;2;255;223;186m",
  "\u001B[38;2;255;255;186m",
  "\u001B[38;2;186;255;201m",
  "\u001B[38;2;186;225;255m",
  "\u001B[38;2;218;186;255m",
];
const RESET_FG = "\u001B[39m";

export function buildCoreUIWorkingIndicator(): WorkingIndicatorOptions {
  return {
    frames: DOTS2_FRAMES.map((frame, index) => {
      const color = PASTEL_COLORS[index % PASTEL_COLORS.length] ?? PASTEL_COLORS[0];
      return colorizeFrame(frame, color);
    }),
    intervalMs: DOTS2_INTERVAL_MS,
  };
}

export function applyCoreUIWorkingIndicator(ctx: ExtensionContext): void {
  ctx.ui.setWorkingIndicator(buildCoreUIWorkingIndicator());
}

function colorizeFrame(frame: string, color: string): string {
  return `${color}${frame}${RESET_FG}`;
}
