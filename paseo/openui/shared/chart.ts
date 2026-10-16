/** Pure geometry for the native charts: scales, ticks, rotated-view segments, pie angles, stacking. */

export interface Segment {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Radians, to rotate the box about its own center. */
  rotate: number;
}

/** A thin box from (x1,y1) to (x2,y2): a line drawn as a rotated View, since plugins have no SVG. */
export function segment(x1: number, y1: number, x2: number, y2: number, thickness: number): Segment {
  const length = Math.hypot(x2 - x1, y2 - y1);
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  return { left: cx - length / 2, top: cy - thickness / 2, width: length, height: thickness, rotate: Math.atan2(y2 - y1, x2 - x1) };
}

export interface Scale {
  min: number;
  max: number;
  ticks: number[];
}

/** A rounded axis that contains [min, max] with about `count` tick marks. */
export function niceScale(min: number, max: number, count = 4): Scale {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, ticks: [0, 1] };
  if (min === max) {
    if (min === 0) return { min: 0, max: 1, ticks: [0, 1] };
    max = min > 0 ? min * 2 : 0;
    min = min > 0 ? 0 : min * 2;
  }
  const raw = (max - min) / Math.max(count, 1);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / magnitude;
  const step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * magnitude;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let value = lo; value <= hi + step / 2; value += step) ticks.push(Number(value.toFixed(10)));
  return { min: lo, max: hi, ticks };
}

/** 1200 -> "1.2k", 0.5 -> "0.5". Short enough for an axis gutter. */
export function formatCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${trim(value / 1e9)}B`;
  if (abs >= 1e6) return `${trim(value / 1e6)}M`;
  if (abs >= 1e4) return `${trim(value / 1e3)}k`;
  return trim(value);
}

function trim(value: number): string {
  return Number(value.toFixed(2)).toString();
}

/** Position of the i-th of n points across `width`; a single point sits in the middle. */
export function pointX(index: number, count: number, width: number): number {
  return count <= 1 ? width / 2 : (index / (count - 1)) * width;
}

/** Which of n points a pointer at x is closest to. */
export function nearestIndex(x: number, count: number, width: number): number {
  if (count <= 1) return 0;
  return Math.min(count - 1, Math.max(0, Math.round((x / width) * (count - 1))));
}

export interface PieSlice {
  start: number;
  end: number;
  fraction: number;
}

/** Angles in radians, clockwise from 12 o'clock (-π/2). Negative and non-finite values count as zero. */
export function pieAngles(values: number[]): PieSlice[] {
  const clean = values.map((value) => (Number.isFinite(value) && value > 0 ? value : 0));
  const total = clean.reduce((sum, value) => sum + value, 0);
  let angle = -Math.PI / 2;
  return clean.map((value) => {
    const fraction = total > 0 ? value / total : 0;
    const start = angle;
    angle += fraction * Math.PI * 2;
    return { start, end: angle, fraction };
  });
}

/** Index of the slice under (x, y) relative to the center, or -1 outside the ring. */
export function pieHit(x: number, y: number, inner: number, outer: number, slices: PieSlice[]): number {
  const distance = Math.hypot(x, y);
  if (distance < inner || distance > outer) return -1;
  let angle = Math.atan2(y, x);
  if (angle < -Math.PI / 2) angle += Math.PI * 2;
  return slices.findIndex((slice) => slice.fraction > 0 && angle >= slice.start && angle < slice.end);
}

export interface Stacked {
  low: number;
  high: number;
}

/** Cumulative [low, high] per series at each index. Negative values are treated as zero. */
export function stackValues(series: number[][]): Stacked[][] {
  const length = Math.max(0, ...series.map((values) => values.length));
  const running = new Array<number>(length).fill(0);
  return series.map((values) =>
    Array.from({ length }, (_, index) => {
      const low = running[index] ?? 0;
      const high = low + Math.max(0, values[index] ?? 0);
      running[index] = high;
      return { low, high };
    }),
  );
}

/** At most `limit` evenly spaced indices to label, always including the first and last. */
export function labelIndices(count: number, limit: number): number[] {
  if (count <= limit) return Array.from({ length: count }, (_, index) => index);
  const step = (count - 1) / (limit - 1);
  return Array.from({ length: limit }, (_, index) => Math.round(index * step));
}

/** Categorical slots in fixed order, validated for light and dark surfaces (dataviz palette). */
const CATEGORICAL = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
} as const;

export function categorical(dark: boolean): readonly string[] {
  return dark ? CATEGORICAL.dark : CATEGORICAL.light;
}

/** Perceived brightness of a #rrggbb color, 0 to 1; non-hex colors count as dark. */
export function luminance(color: string): number {
  const match = /^#([0-9a-f]{6})/i.exec(color);
  if (!match) return 0;
  const n = Number.parseInt(match[1] as string, 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

/** Blend two #rrggbb colors; t=0 is a, t=1 is b. A color that is not hex returns b. */
export function mixColor(a: string, b: string, t: number): string {
  const pa = /^#([0-9a-f]{6})/i.exec(a);
  const pb = /^#([0-9a-f]{6})/i.exec(b);
  if (!pa || !pb) return b;
  const ca = Number.parseInt(pa[1] as string, 16);
  const cb = Number.parseInt(pb[1] as string, 16);
  const clamp = Math.min(1, Math.max(0, t));
  const channel = (shift: number) => Math.round(((ca >> shift) & 255) * (1 - clamp) + ((cb >> shift) & 255) * clamp);
  return `#${[16, 8, 0].map((shift) => channel(shift).toString(16).padStart(2, "0")).join("")}`;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Squarified treemap: one rectangle per value, in input order, tiling w by h by area. Zero values get no area. */
export function treemap(values: number[], w: number, h: number): Rect[] {
  const clean = values.map((value) => (Number.isFinite(value) && value > 0 ? value : 0));
  const total = clean.reduce((sum, value) => sum + value, 0);
  const out: Rect[] = clean.map(() => ({ x: 0, y: 0, w: 0, h: 0 }));
  if (total === 0 || w <= 0 || h <= 0) return out;
  const scale = (w * h) / total;
  const items = clean
    .map((value, index) => ({ index, area: value * scale }))
    .filter((item) => item.area > 0)
    .sort((a, b) => b.area - a.area);
  let free: Rect = { x: 0, y: 0, w, h };
  let row: typeof items = [];
  const worst = (candidate: typeof items, side: number) => {
    const sum = candidate.reduce((s, item) => s + item.area, 0);
    const max = Math.max(...candidate.map((item) => item.area));
    const min = Math.min(...candidate.map((item) => item.area));
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };
  const place = () => {
    const sum = row.reduce((s, item) => s + item.area, 0);
    if (free.w >= free.h) {
      const width = sum / free.h;
      let y = free.y;
      for (const item of row) {
        const height = item.area / width;
        out[item.index] = { x: free.x, y, w: width, h: height };
        y += height;
      }
      free = { x: free.x + width, y: free.y, w: free.w - width, h: free.h };
    } else {
      const height = sum / free.w;
      let x = free.x;
      for (const item of row) {
        const width = item.area / height;
        out[item.index] = { x, y: free.y, w: width, h: height };
        x += width;
      }
      free = { x: free.x, y: free.y + height, w: free.w, h: free.h - height };
    }
    row = [];
  };
  for (const item of items) {
    const side = Math.min(free.w, free.h);
    if (row.length === 0 || worst([...row, item], side) <= worst(row, side)) row.push(item);
    else {
      place();
      row.push(item);
    }
  }
  if (row.length > 0) place();
  return out;
}

/** Parses an ISO date or a plain number; NaN when it is neither. */
export function parseTime(value: unknown): number {
  if (typeof value === "number") return value;
  const text = String(value ?? "").trim();
  if (text !== "" && Number.isFinite(Number(text))) return Number(text);
  return Date.parse(text);
}

/** A time in the same form it was written: a date for ISO input, a compact number otherwise. */
export function formatTime(ms: number, asDate: boolean): string {
  if (!asDate) return formatCompact(ms);
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

/** Warn and danger thresholds to a status color name; higher is worse. */
export function gaugeTone(value: number, warnAt?: number, dangerAt?: number): "default" | "warning" | "danger" {
  if (dangerAt !== undefined && value >= dangerAt) return "danger";
  if (warnAt !== undefined && value >= warnAt) return "warning";
  return "default";
}

export interface Histogram {
  edges: number[];
  counts: number[];
}

/** Equal-width bins over the data range; the last bin includes its upper edge. Default count follows Sturges' rule. */
export function histogram(values: number[], bins?: number): Histogram {
  const clean = values.filter((value) => Number.isFinite(value));
  if (clean.length === 0) return { edges: [0, 1], counts: [0] };
  const count = Math.max(1, Math.min(60, Math.round(bins ?? Math.ceil(Math.log2(clean.length)) + 1)));
  const low = Math.min(...clean);
  const high = Math.max(...clean);
  const width = (high - low || 1) / count;
  const edges = Array.from({ length: count + 1 }, (_, index) => low + index * width);
  const counts = Array.from({ length: count }, () => 0);
  for (const value of clean) {
    const index = Math.min(count - 1, Math.floor((value - low) / width));
    counts[index] = (counts[index] as number) + 1;
  }
  return { edges, counts };
}

function quantile(sorted: number[], q: number): number {
  const position = (sorted.length - 1) * q;
  const below = Math.floor(position);
  const above = Math.ceil(position);
  return (sorted[below] as number) + ((sorted[above] as number) - (sorted[below] as number)) * (position - below);
}

export interface BoxStats {
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  outliers: number[];
}

/** Quartiles with Tukey whiskers: the furthest values within 1.5 IQR of the box; the rest are outliers. */
export function boxStats(values: number[]): BoxStats | null {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const fence = 1.5 * (q3 - q1);
  const inside = sorted.filter((value) => value >= q1 - fence && value <= q3 + fence);
  return {
    min: inside[0] as number,
    q1,
    median: quantile(sorted, 0.5),
    q3,
    max: inside[inside.length - 1] as number,
    outliers: sorted.filter((value) => value < q1 - fence || value > q3 + fence),
  };
}

/** Least-squares line through the points, or null when x does not vary. */
export function linearFit(points: number[][]): { slope: number; intercept: number } | null {
  const n = points.length;
  if (n < 2) return null;
  const meanX = points.reduce((sum, p) => sum + (p[0] as number), 0) / n;
  const meanY = points.reduce((sum, p) => sum + (p[1] as number), 0) / n;
  const spread = points.reduce((sum, p) => sum + ((p[0] as number) - meanX) ** 2, 0);
  if (spread === 0) return null;
  const slope = points.reduce((sum, p) => sum + ((p[0] as number) - meanX) * ((p[1] as number) - meanY), 0) / spread;
  return { slope, intercept: meanY - slope * meanX };
}

export interface WaterfallBar {
  start: number;
  end: number;
  total: boolean;
}

/** Floating bars: each delta starts where the last ended; a total bar spans from zero to the running sum (or its own value). */
export function waterfall(steps: Array<{ value: number; total: boolean }>): WaterfallBar[] {
  let running = 0;
  return steps.map((step) => {
    if (step.total) {
      const end = step.value === 0 ? running : step.value;
      running = end;
      return { start: 0, end, total: true };
    }
    const bar = { start: running, end: running + step.value, total: false };
    running = bar.end;
    return bar;
  });
}

/** Week columns of a calendar heatmap: Monday-first rows 0..6, week index counted from the first date's week. */
export function calendarCell(time: number, firstTime: number): { week: number; row: number } {
  const day = 86_400_000;
  const row = (new Date(time).getUTCDay() + 6) % 7;
  const firstRow = (new Date(firstTime).getUTCDay() + 6) % 7;
  return { week: Math.floor((Math.round((time - firstTime) / day) + firstRow) / 7), row };
}

/** Corner of a radar polygon: axis i of n, starting at the top and going clockwise. */
export function radarPoint(index: number, count: number, radius: number): { x: number; y: number } {
  const angle = -Math.PI / 2 + (index / count) * Math.PI * 2;
  return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
}

/** Each category's series values as a percent of that category's total. */
export function percentOfTotal(series: number[][]): number[][] {
  const length = Math.max(0, ...series.map((values) => values.length));
  const totals = Array.from({ length }, (_, index) => series.reduce((sum, values) => sum + Math.max(0, values[index] ?? 0), 0));
  return series.map((values) => values.map((value, index) => ((totals[index] as number) > 0 ? (Math.max(0, value) / (totals[index] as number)) * 100 : 0)));
}
