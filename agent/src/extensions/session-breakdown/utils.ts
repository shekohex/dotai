import { BorderedLoader } from "@mariozechner/pi-coding-agent";
import os from "node:os";
import type { RGB } from "./types.js";

export const DEFAULT_BG: RGB = { r: 13, g: 17, b: 23 };
export const EMPTY_CELL_BG: RGB = { r: 22, g: 27, b: 34 };

export const PALETTE: RGB[] = [
  { r: 64, g: 196, b: 99 },
  { r: 47, g: 129, b: 247 },
  { r: 163, g: 113, b: 247 },
  { r: 255, g: 159, b: 10 },
  { r: 244, g: 67, b: 54 },
];

function readObjectProperty<T extends PropertyKey>(target: object, key: T): unknown {
  return hasProperty(target, key) ? target[key] : undefined;
}

function hasProperty<T extends PropertyKey>(
  target: object,
  key: T,
): target is object & Record<T, unknown> {
  return key in target;
}

export function setBorderedLoaderMessage(loader: BorderedLoader, message: string) {
  const inner = readObjectProperty(loader, "loader");
  if (inner === null || typeof inner !== "object" || Array.isArray(inner)) {
    return;
  }

  const setMessage = readObjectProperty(inner, "setMessage");
  if (typeof setMessage === "function") {
    setMessage.call(inner, message);
  }
}

export function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return {
    r: Math.round(lerp(a.r, b.r, t)),
    g: Math.round(lerp(a.g, b.g, t)),
    b: Math.round(lerp(a.b, b.b, t)),
  };
}

export function weightedMix(colors: Array<{ color: RGB; weight: number }>): RGB {
  let total = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  for (const c of colors) {
    if (!Number.isFinite(c.weight) || c.weight <= 0) continue;
    total += c.weight;
    r += c.color.r * c.weight;
    g += c.color.g * c.weight;
    b += c.color.b * c.weight;
  }
  if (total <= 0) return EMPTY_CELL_BG;
  return { r: Math.round(r / total), g: Math.round(g / total), b: Math.round(b / total) };
}

export function ansiFg(rgb: RGB, text: string): string {
  return `\u001B[38;2;${rgb.r};${rgb.g};${rgb.b}m${text}\u001B[0m`;
}

export function dim(text: string): string {
  return `\u001B[2m${text}\u001B[0m`;
}

export function bold(text: string): string {
  return `\u001B[1m${text}\u001B[0m`;
}

export function parseNumericValue(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

export function isAbortRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

export function pickFallbackMap(
  preferred: Map<string, number>,
  secondary: Map<string, number>,
  tertiary: Map<string, number>,
  preferredTotal: number,
  secondaryTotal: number,
): Map<string, number> {
  if (preferredTotal > 0) {
    return preferred;
  }

  if (secondaryTotal > 0) {
    return secondary;
  }

  return tertiary;
}

export function parseTimestampValue(value: string | undefined): Date | null {
  if (value === undefined || value.length === 0) {
    return null;
  }

  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function normalizeCwdValue(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function reportFoundProgress(
  onFound: ((found: number) => void) | undefined,
  count: number,
): void {
  if (onFound === undefined || count % 10 !== 0) {
    return;
  }

  onFound(count);
}

export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "0";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString("en-US");
}

export function formatUsd(cost: number): string {
  if (!Number.isFinite(cost)) return "$0.00";
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(4)}`;
}

export function abbreviatePath(p: string, maxWidth = 40): string {
  const home = os.homedir();
  let display = p;
  if (display.startsWith(home)) {
    display = "~" + display.slice(home.length);
  }
  if (display.length <= maxWidth) return display;

  const parts = display.split("/").filter(Boolean);
  if (parts.length <= 2) return display;

  const prefix = parts[0];
  for (let keep = parts.length - 1; keep >= 1; keep--) {
    const tail = parts.slice(parts.length - keep);
    const candidate = prefix + "/…/" + tail.join("/");
    if (candidate.length <= maxWidth || keep === 1) return candidate;
  }
  return display;
}

export function padRight(s: string, n: number): string {
  const delta = n - s.length;
  return delta > 0 ? s + " ".repeat(delta) : s;
}

export function padLeft(s: string, n: number): string {
  const delta = n - s.length;
  return delta > 0 ? " ".repeat(delta) + s : s;
}

export function toLocalDayKey(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function localMidnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

export function addDaysLocal(d: Date, days: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

export function countDaysInclusiveLocal(start: Date, end: Date): number {
  let n = 0;
  for (let d = new Date(start); d <= end; d = addDaysLocal(d, 1)) n++;
  return n;
}

export function mondayIndex(date: Date): number {
  return (date.getDay() + 6) % 7;
}

export function modelKeyFromParts(provider?: unknown, model?: unknown): string | null {
  const p = typeof provider === "string" ? provider.trim() : "";
  const m = typeof model === "string" ? model.trim() : "";
  if (!p && !m) return null;
  if (!p) return m;
  if (!m) return p;
  return `${p}/${m}`;
}

export function parseSessionStartFromFilename(name: string): Date | null {
  const m = name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/);
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : null;
}
