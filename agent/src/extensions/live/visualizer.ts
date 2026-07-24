import type { Component } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

export type LivePhase =
  | "waiting-for-app"
  | "pairing"
  | "connecting"
  | "listening"
  | "working"
  | "speaking"
  | "muted"
  | "ending"
  | "reconnecting"
  | "error";

export interface LiveVisualizerOptions {
  theme: Theme;
  endpointSummary: string;
  requestRender(): void;
  onStop(): void;
  onToggleMute(): void;
  onCopy(): void;
}

function normalizeTranscript(text: string): string {
  let sanitized = "";
  for (const character of text.replaceAll("\t", "    ")) {
    const codePoint = character.codePointAt(0) ?? 0;
    sanitized += codePoint < 32 || codePoint === 127 ? " " : character;
  }
  return sanitized.replaceAll(/\s+/gu, " ").trim();
}

function truncateFromStart(text: string, width: number): string {
  if (width <= 0) return "";
  const textWidth = visibleWidth(text);
  if (textWidth <= width) return text;
  if (width === 1) return "…";
  const characters = Array.from(text);
  return `…${characters.slice(Math.max(0, characters.length - width + 1)).join("")}`;
}

function liveContent(phase: LivePhase, transcript: string, endpointSummary: string): string {
  if (phase === "waiting-for-app") return `Pair on Mac · ${endpointSummary}`;
  return transcript.length > 0 ? transcript : "Pi Live";
}

function waitingHelp(copied: boolean): string {
  return copied ? " copied · esc end " : " enter copy pairing URL · esc end ";
}

function spectrumColor(phase: LivePhase): ThemeColor {
  if (phase === "muted") return "dim";
  if (phase === "error") return "error";
  return "success";
}

/** OMP-derived fixed-height live visualizer with a pairing state. */
export class LiveVisualizer implements Component {
  readonly wantsKeyRelease = false;
  readonly #options: LiveVisualizerOptions;
  #phase: LivePhase = "waiting-for-app";
  #inputLevel = 0;
  #displayLevel = 0;
  #frame = 0;
  #transcript = "";
  #copiedUntil = 0;
  #cacheKey = "";
  #cache: string[] = [];

  constructor(options: LiveVisualizerOptions) {
    this.#options = options;
  }

  setPhase(phase: LivePhase): void {
    if (this.#phase === phase) return;
    this.#phase = phase;
    this.invalidate();
  }

  setInputLevel(level: number): void {
    const next = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
    if (this.#inputLevel === next) return;
    this.#inputLevel = next;
    if (next > this.#displayLevel) this.#displayLevel = next;
    this.invalidate();
  }

  setFrame(frame: number): void {
    const nextLevel = Math.max(this.#inputLevel, this.#displayLevel * 0.84);
    if (this.#frame === frame && this.#displayLevel === nextLevel) return;
    this.#frame = frame;
    this.#displayLevel = nextLevel;
    if (this.#copiedUntil !== 0 && Date.now() > this.#copiedUntil) this.#copiedUntil = 0;
    this.invalidate();
  }

  setTranscript(text: string): void {
    const normalized = normalizeTranscript(text);
    if (this.#transcript === normalized) return;
    this.#transcript = normalized;
    this.invalidate();
  }

  clearTranscript(): void {
    if (!this.#transcript) return;
    this.#transcript = "";
    this.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.#options.onStop();
    } else if (matchesKey(data, "space")) {
      this.#options.onToggleMute();
    } else if (matchesKey(data, "enter")) {
      this.#options.onCopy();
      this.#copiedUntil = Date.now() + 2_000;
      this.invalidate();
      this.#options.requestRender();
    }
  }

  invalidate(): void {
    this.#cacheKey = "";
  }

  render(maxWidth: number): string[] {
    const key = [
      maxWidth,
      this.#phase,
      this.#displayLevel,
      this.#frame,
      this.#transcript,
      this.#copiedUntil,
    ].join("|");
    if (key === this.#cacheKey) return this.#cache;
    this.#cacheKey = key;
    this.#cache = this.#renderLines(maxWidth);
    return this.#cache;
  }

  #renderLines(maxWidth: number): string[] {
    const theme = this.#options.theme;
    const width = Math.max(2, maxWidth);
    const innerWidth = width - 2;
    const border = (content: string): string =>
      theme.fg("border", "│") + content + (width > 1 ? theme.fg("border", "│") : "");
    const top = theme.fg("border", `┌${"─".repeat(innerWidth)}${width > 1 ? "┐" : ""}`);
    const color = spectrumColor(this.#phase);
    const spectrumRows = this.#generateSpectrum(innerWidth, 2).map((row) =>
      border(theme.fg(color, row)),
    );
    const content = liveContent(this.#phase, this.#transcript, this.#options.endpointSummary);
    const text = truncateFromStart(content, innerWidth);
    const transcript = border(
      theme.fg(this.#phase === "waiting-for-app" ? "muted" : "accent", text) +
        " ".repeat(Math.max(0, innerWidth - visibleWidth(text))),
    );
    return [top, ...spectrumRows, transcript, this.#renderFooter(width, innerWidth)];
  }

  #renderFooter(width: number, innerWidth: number): string {
    const theme = this.#options.theme;
    const spinners = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const staticIcons: Record<LivePhase, string> = {
      "waiting-for-app": "○",
      pairing: "○",
      connecting: "○",
      listening: "●",
      working: "○",
      speaking: "»",
      muted: "×",
      ending: "×",
      reconnecting: "○",
      error: "!",
    };
    const animated =
      this.#phase === "working" || this.#phase === "connecting" || this.#phase === "pairing";
    const icon = animated ? spinners[this.#frame % spinners.length] : staticIcons[this.#phase];
    const phaseColors: Record<LivePhase, ThemeColor> = {
      "waiting-for-app": "warning",
      pairing: "warning",
      connecting: "dim",
      listening: "success",
      working: "warning",
      speaking: "accent",
      muted: "dim",
      ending: "dim",
      reconnecting: "warning",
      error: "error",
    };
    const status = `${icon} ${this.#phase}`;
    const help =
      this.#phase === "waiting-for-app"
        ? waitingHelp(this.#copiedUntil > Date.now())
        : " space mute · esc end ";
    const fullLabel = ` ${status} ·${help}`;
    const shortLabel = ` ${status} `;
    let label = "";
    if (innerWidth >= visibleWidth(fullLabel) + 1) label = fullLabel;
    else if (innerWidth >= visibleWidth(shortLabel) + 1) label = shortLabel;
    if (!label) return theme.fg("border", `└${"─".repeat(innerWidth)}${width > 1 ? "┘" : ""}`);
    const remaining = Math.max(0, innerWidth - visibleWidth(label) - 1);
    return (
      theme.fg("border", "└─") +
      theme.fg(phaseColors[this.#phase], truncateToWidth(label, innerWidth - 1)) +
      theme.fg("border", `${"─".repeat(remaining)}${width > 1 ? "┘" : ""}`)
    );
  }

  #generateSpectrum(width: number, rows: number): string[] {
    const blocks = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
    const output = Array.from({ length: rows }, () => "");
    const waiting =
      this.#phase === "waiting-for-app" ||
      this.#phase === "pairing" ||
      this.#phase === "connecting";
    const ambient = waiting ? 0.035 + 0.02 * Math.sin(this.#frame * 0.15) : 0;
    const energy =
      this.#phase === "muted"
        ? 0
        : Math.min(1, Math.sqrt(Math.max(this.#displayLevel, ambient) * 5));
    const maxHeight = rows * (blocks.length - 1);
    for (let column = 0; column < width; column += 1) {
      const carrier = 0.5 + 0.5 * Math.sin(this.#frame * 0.43 + column * 0.71);
      const shimmer = 0.5 + 0.5 * Math.sin(this.#frame * 0.19 - column * 1.17);
      const height = Math.round(energy * (0.3 + carrier * 0.5 + shimmer * 0.2) * maxHeight);
      for (let row = 0; row < rows; row += 1) {
        const units = Math.max(0, Math.min(blocks.length - 1, height - (rows - row - 1) * 8));
        output[row] += blocks[units];
      }
    }
    return output;
  }
}
