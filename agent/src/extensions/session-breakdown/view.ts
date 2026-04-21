import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { BreakdownData, BreakdownView, MeasurementMode, RGB, RangeAgg } from "./types.js";
import { RANGE_DAYS, todBucketLabel } from "./types.js";
import { graphMetricForRange, rangeSummary, weeksForRange } from "./metrics.js";
import { renderGraphLines } from "./graph.js";
import {
  displayModelName,
  renderCwdTable,
  renderDowDistributionLines,
  renderDowTable,
  renderModelTable,
  renderTodTable,
} from "./tables.js";
import { abbreviatePath, ansiFg, bold, dim } from "./utils.js";

type BreakdownRenderInput = {
  width: number;
  rangeIndex: number;
  measurement: MeasurementMode;
  view: BreakdownView;
};

type BreakdownLegendState = {
  activeColorMap: Map<string, RGB>;
  activeOtherColor: RGB;
  legendItems: string[];
  legendTitle: string;
};

export function buildBreakdownComponentLines(
  data: BreakdownData,
  input: BreakdownRenderInput,
): string[] {
  const selectedDays = RANGE_DAYS[input.rangeIndex] ?? RANGE_DAYS[1];
  const range = data.ranges.get(selectedDays);
  if (!range) {
    return ["No breakdown data available"];
  }

  const metric = graphMetricForRange(range, input.measurement);
  const legend = buildBreakdownLegendState(data, input.view);
  const header = buildBreakdownHeader(input.rangeIndex, input.measurement, input.view);
  const summary = buildBreakdownSummary(range, selectedDays, metric.kind, input.view);
  const graphLines = buildBreakdownGraphLines(
    data,
    range,
    input,
    legend.activeColorMap,
    legend.activeOtherColor,
  );
  const tableLines = buildBreakdownTableLines(range, metric.kind, input.view);
  const lines: string[] = [
    truncateToWidth(header, input.width),
    truncateToWidth(dim("←/→ range · ↑/↓ view · tab metric · q to close"), input.width),
    "",
    truncateToWidth(summary, input.width),
    "",
  ];
  appendBreakdownGraphSection(lines, graphLines, input.width, input.view, legend);
  lines.push("");
  for (const tableLine of tableLines) {
    lines.push(truncateToWidth(tableLine, input.width));
  }

  return lines.map((line) =>
    visibleWidth(line) > input.width ? truncateToWidth(line, input.width) : line,
  );
}

function buildBreakdownHeader(
  rangeIndex: number,
  measurement: MeasurementMode,
  view: BreakdownView,
): string {
  const rangeTabs = RANGE_DAYS.map((days, idx) =>
    idx === rangeIndex ? bold(`[${days}d]`) : dim(` ${days}d `),
  ).join("");
  const metricTabs =
    (measurement === "sessions" ? bold("[sess]") : dim(" sess ")) +
    (measurement === "messages" ? bold("[msg]") : dim(" msg ")) +
    (measurement === "tokens" ? bold("[tok]") : dim(" tok "));
  const viewTabs =
    (view === "model" ? bold("[model]") : dim(" model ")) +
    (view === "cwd" ? bold("[cwd]") : dim(" cwd ")) +
    (view === "dow" ? bold("[dow]") : dim(" dow ")) +
    (view === "tod" ? bold("[tod]") : dim(" tod "));
  return `${bold("Session breakdown")}  ${rangeTabs}  ${metricTabs}  ${viewTabs}`;
}

function buildBreakdownSummary(
  range: RangeAgg,
  selectedDays: number,
  metricKind: "sessions" | "messages" | "tokens",
  view: BreakdownView,
): string {
  const graphDescriptor =
    view === "dow" ? `share of ${metricKind} by weekday` : `${metricKind}/day`;
  return rangeSummary(range, selectedDays, metricKind) + dim(`   (graph: ${graphDescriptor})`);
}

function buildBreakdownLegendState(data: BreakdownData, view: BreakdownView): BreakdownLegendState {
  if (view === "model") {
    return buildModelLegendState(data);
  }

  if (view === "cwd") {
    return buildCwdLegendState(data);
  }

  if (view === "dow") {
    return buildDowLegendState(data);
  }

  return buildTodLegendState(data);
}

function buildModelLegendState(data: BreakdownData): BreakdownLegendState {
  return {
    activeColorMap: data.palette.modelColors,
    activeOtherColor: data.palette.otherColor,
    legendItems: [
      ...buildLegendItems(data.palette.orderedModels, data.palette.modelColors, (value) =>
        displayModelName(value),
      ),
      `${ansiFg(data.palette.otherColor, "█")} other`,
    ],
    legendTitle: "Top models (30d palette):",
  };
}

function buildCwdLegendState(data: BreakdownData): BreakdownLegendState {
  return {
    activeColorMap: data.cwdPalette.cwdColors,
    activeOtherColor: data.cwdPalette.otherColor,
    legendItems: [
      ...buildLegendItems(data.cwdPalette.orderedCwds, data.cwdPalette.cwdColors, (value) =>
        abbreviatePath(value, 30),
      ),
      `${ansiFg(data.cwdPalette.otherColor, "█")} other`,
    ],
    legendTitle: "Top directories (30d palette):",
  };
}

function buildDowLegendState(data: BreakdownData): BreakdownLegendState {
  return {
    activeColorMap: data.dowPalette.dowColors,
    activeOtherColor: { r: 160, g: 160, b: 160 },
    legendItems: buildLegendItems(
      data.dowPalette.orderedDows,
      data.dowPalette.dowColors,
      (value) => value,
    ),
    legendTitle: "Weekdays:",
  };
}

function buildTodLegendState(data: BreakdownData): BreakdownLegendState {
  return {
    activeColorMap: data.todPalette.todColors,
    activeOtherColor: { r: 160, g: 160, b: 160 },
    legendItems: buildLegendItems(data.todPalette.orderedTods, data.todPalette.todColors, (value) =>
      todBucketLabel(value),
    ),
    legendTitle: "Time of day:",
  };
}

function buildLegendItems<T extends string>(
  keys: T[],
  colorMap: Map<T, RGB>,
  labelFor: (value: T) => string,
): string[] {
  return keys
    .map((value) => {
      const color = colorMap.get(value);
      return color ? `${ansiFg(color, "█")} ${labelFor(value)}` : undefined;
    })
    .filter((line): line is string => line !== undefined);
}

function buildBreakdownGraphLines(
  data: BreakdownData,
  range: RangeAgg,
  input: BreakdownRenderInput,
  activeColorMap: Map<string, RGB>,
  activeOtherColor: RGB,
): string[] {
  if (input.view === "dow") {
    return renderDowDistributionLines(
      range,
      input.measurement,
      data.dowPalette.dowColors,
      input.width,
    );
  }

  const maxScale = input.width > 0 && (RANGE_DAYS[input.rangeIndex] ?? 30) === 7 ? 4 : 3;
  const weeks = weeksForRange(range);
  const graphArea = Math.max(1, input.width - 4);
  const idealCellWidth = Math.floor((graphArea + 1) / Math.max(1, weeks)) - 1;
  const cellWidth = Math.min(maxScale, Math.max(1, idealCellWidth));
  return renderGraphLines(
    range,
    activeColorMap,
    activeOtherColor,
    input.measurement,
    { cellWidth, gap: 1 },
    input.view,
  );
}

function buildBreakdownTableLines(
  range: RangeAgg,
  metricKind: "sessions" | "messages" | "tokens",
  view: BreakdownView,
): string[] {
  if (view === "model") return renderModelTable(range, metricKind, 8);
  if (view === "cwd") return renderCwdTable(range, metricKind, 8);
  if (view === "dow") return renderDowTable(range, metricKind);
  return renderTodTable(range, metricKind);
}

function appendBreakdownGraphSection(
  lines: string[],
  graphLines: string[],
  width: number,
  view: BreakdownView,
  legend: BreakdownLegendState,
): void {
  if (view === "dow") {
    for (const graphLine of graphLines) {
      lines.push(truncateToWidth(graphLine, width));
    }
    return;
  }

  const graphWidth = Math.max(0, ...graphLines.map((line) => visibleWidth(line)));
  const legendWidth = width - graphWidth - 2;
  if (legendWidth >= 22) {
    appendBreakdownSideLegend(lines, graphLines, graphWidth, legendWidth, legend);
    return;
  }

  for (const graphLine of graphLines) {
    lines.push(truncateToWidth(graphLine, width));
  }
  lines.push("");
  lines.push(truncateToWidth(dim(legend.legendTitle), width));
  for (const legendItem of legend.legendItems) {
    lines.push(truncateToWidth(legendItem, width));
  }
}

function appendBreakdownSideLegend(
  lines: string[],
  graphLines: string[],
  graphWidth: number,
  legendWidth: number,
  legend: BreakdownLegendState,
): void {
  const legendLines = [dim(legend.legendTitle), ...legend.legendItems];
  while (legendLines.length < graphLines.length) {
    legendLines.push("");
  }

  const visibleLegend =
    legendLines.length > graphLines.length
      ? [
          ...legendLines.slice(0, graphLines.length - 1),
          dim(`+${legendLines.length - graphLines.length + 1} more`),
        ]
      : legendLines.slice(0, graphLines.length);
  for (let i = 0; i < graphLines.length; i++) {
    const left = padRightAnsi(graphLines[i] ?? "", graphWidth);
    const right = truncateToWidth(visibleLegend[i] ?? "", Math.max(0, legendWidth));
    lines.push(truncateToWidth(left + "  " + right, graphWidth + 2 + legendWidth));
  }
}

function padRightAnsi(value: string, targetWidth: number): string {
  const width = visibleWidth(value);
  return width >= targetWidth ? value : value + " ".repeat(targetWidth - width);
}
