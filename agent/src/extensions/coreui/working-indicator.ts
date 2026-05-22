import type { ExtensionContext, WorkingIndicatorOptions } from "@earendil-works/pi-coding-agent";

export const COREUI_SHIMMER_INTERVAL_MS = 80;
const DOTS2_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];
export const COREUI_PASTEL_COLORS = [
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
      const color =
        COREUI_PASTEL_COLORS[index % COREUI_PASTEL_COLORS.length] ?? COREUI_PASTEL_COLORS[0];
      return colorizeFrame(frame, color);
    }),
    intervalMs: COREUI_SHIMMER_INTERVAL_MS,
  };
}

export function applyCoreUIWorkingIndicator(ctx: ExtensionContext): void {
  ctx.ui.setWorkingIndicator(buildCoreUIWorkingIndicator());
}

function colorizeFrame(frame: string, color: string): string {
  return `${color}${frame}${RESET_FG}`;
}

export function colorizeCoreUIShimmerFrame(frame: string, nowMs = Date.now()): string {
  const index = Math.floor(nowMs / COREUI_SHIMMER_INTERVAL_MS) % COREUI_PASTEL_COLORS.length;
  const color = COREUI_PASTEL_COLORS[index] ?? COREUI_PASTEL_COLORS[0];
  return colorizeFrame(frame, color);
}
