import type { BreakdownView, DayAgg, MeasurementMode, RangeAgg, RGB } from "./types.js";
import { dayMixedColor } from "./palette.js";
import {
  EMPTY_CELL_BG,
  DEFAULT_BG,
  addDaysLocal,
  ansiFg,
  clamp01,
  countDaysInclusiveLocal,
  mixRgb,
  mondayIndex,
  padRight,
  toLocalDayKey,
} from "./utils.js";
import { graphMetricForRange } from "./metrics.js";

type GraphLayout = {
  start: Date;
  end: Date;
  gridStart: Date;
  weeks: number;
  cellWidth: number;
  block: string;
  gapStr: string;
};

function createGraphLayout(
  start: Date,
  end: Date,
  options: { cellWidth?: number; gap?: number } | undefined,
): GraphLayout {
  const gridStart = addDaysLocal(start, -mondayIndex(start));
  const gridEnd = addDaysLocal(end, 6 - mondayIndex(end));
  const totalGridDays = countDaysInclusiveLocal(gridStart, gridEnd);
  const weeks = Math.ceil(totalGridDays / 7);
  const cellWidth = Math.max(1, Math.floor(options?.cellWidth ?? 1));
  const gap = Math.max(0, Math.floor(options?.gap ?? 1));
  return {
    start,
    end,
    gridStart,
    weeks,
    cellWidth,
    block: "█".repeat(cellWidth),
    gapStr: " ".repeat(gap),
  };
}

function readDayMetricValue(
  day: DayAgg | undefined,
  metricKind: "sessions" | "messages" | "tokens",
): number {
  if (metricKind === "tokens") {
    return day?.tokens ?? 0;
  }
  if (metricKind === "messages") {
    return day?.messages ?? 0;
  }

  return day?.sessions ?? 0;
}

function renderGraphCell(
  week: number,
  row: number,
  range: RangeAgg,
  layout: GraphLayout,
  metricKind: "sessions" | "messages" | "tokens",
  denom: number,
  colorMap: Map<string, RGB>,
  otherColor: RGB,
  mode: MeasurementMode,
  view: BreakdownView,
): string {
  const cellDate = addDaysLocal(layout.gridStart, week * 7 + row);
  const colGap = week < layout.weeks - 1 ? layout.gapStr : "";
  if (cellDate < layout.start || cellDate > layout.end) {
    return " ".repeat(layout.cellWidth) + colGap;
  }

  const day = range.dayByKey.get(toLocalDayKey(cellDate));
  const value = readDayMetricValue(day, metricKind);
  if (!day || value <= 0) {
    return ansiFg(EMPTY_CELL_BG, layout.block) + colGap;
  }

  const hue = dayMixedColor(day, colorMap, otherColor, mode, view);
  const intensity = 0.2 + (1 - 0.2) * clamp01(denom > 0 ? Math.log1p(value) / denom : 0);
  const rgb = mixRgb(DEFAULT_BG, hue, intensity);
  return ansiFg(rgb, layout.block) + colGap;
}

function renderGraphRow(
  row: number,
  range: RangeAgg,
  layout: GraphLayout,
  metricKind: "sessions" | "messages" | "tokens",
  denom: number,
  colorMap: Map<string, RGB>,
  otherColor: RGB,
  mode: MeasurementMode,
  view: BreakdownView,
): string {
  const labelByRow = new Map<number, string>([
    [0, "Mon"],
    [2, "Wed"],
    [4, "Fri"],
  ]);
  const label = labelByRow.get(row);
  let line = label === undefined ? "    " : padRight(label, 3) + " ";
  for (let w = 0; w < layout.weeks; w++) {
    line += renderGraphCell(
      w,
      row,
      range,
      layout,
      metricKind,
      denom,
      colorMap,
      otherColor,
      mode,
      view,
    );
  }

  return line;
}

export function renderGraphLines(
  range: RangeAgg,
  colorMap: Map<string, RGB>,
  otherColor: RGB,
  mode: MeasurementMode,
  options?: { cellWidth?: number; gap?: number },
  view: BreakdownView = "model",
): string[] {
  const days = range.days;
  const firstDay = days.at(0);
  const lastDay = days.at(-1);
  if (firstDay === undefined || lastDay === undefined) {
    return [];
  }

  const layout = createGraphLayout(firstDay.date, lastDay.date, options);
  const metric = graphMetricForRange(range, mode);
  const lines: string[] = [];
  for (let row = 0; row < 7; row++) {
    lines.push(
      renderGraphRow(
        row,
        range,
        layout,
        metric.kind,
        metric.denom,
        colorMap,
        otherColor,
        mode,
        view,
      ),
    );
  }

  return lines;
}
