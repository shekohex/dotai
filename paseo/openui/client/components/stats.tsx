import { type ReactNode, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { boxStats, calendarCell, formatCompact, histogram, mixColor, niceScale, parseTime, radarPoint, waterfall } from "../../shared/chart";
import { LTR_TEXT, useBidi } from "../bidi";
import { isElement } from "../runtime";
import { FONT, GAP, MONO, useUiEnv } from "../tokens";
import { Axis, Dot, Frame, GUTTER_X, GUTTER_Y, Key, Line, PLOT_H, ReadoutCard, type Readout, XLabels, Zones, list, numbers, text, tooltipPlacement, useChartPalette, value } from "./chart";
import type { NodeProps } from "./types";

/** Funnel, Waterfall, Histogram, BoxPlot, Candlestick, RadarChart and CalendarHeatmap. Drawn with Views like the other charts. */

const FUNNEL_BAR_H = 20;
const RADAR_LABEL = 76;
const CALENDAR_MIN_CELL = 11;
const CALENDAR_MAX_CELL = 18;
const CALENDAR_GUTTER = 26;
const WEEKDAYS = ["Mon", "", "Wed", "", "Fri", "", ""];

function percentText(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "0%";
}

/** A y-range plot with a hit strip per category, a tooltip and category labels underneath. */
function CategoryPlot({ width, scale, rows, unit, readout, active, onActive, children }: { width: number; scale: { min: number; max: number; ticks: number[] }; rows: string[]; unit?: string; readout: Readout | null; active: number | null; onActive: (index: number | null) => void; children: (plotW: number, toY: (v: number) => number) => ReactNode }) {
  const { colors } = useUiEnv();
  const plotW = width - GUTTER_Y;
  const span = scale.max - scale.min || 1;
  const toY = (v: number) => PLOT_H - ((v - scale.min) / span) * PLOT_H;
  const slot = plotW / Math.max(1, rows.length);
  const activeX = active === null ? null : slot * active + slot / 2;
  return (
    <View style={{ height: PLOT_H + GUTTER_X + 6 }}>
      <Axis scale={scale} plotW={plotW} colors={colors} {...(unit ? { unit } : {})} />
      <View style={{ position: "absolute", left: GUTTER_Y, top: 0, width: plotW, height: PLOT_H }}>
        {children(plotW, toY)}
        <Zones count={rows.length} plotW={plotW} centered active={active} onActive={onActive} />
        {readout && activeX !== null ? <ReadoutCard readout={readout} style={tooltipPlacement(activeX, plotW)} /> : null}
      </View>
      <XLabels labels={rows} plotW={plotW} colors={colors} centered />
    </View>
  );
}

export function Funnel({ props }: NodeProps) {
  const { colors, pick } = useChartPalette();
  const bidi = useBidi();
  const stages = list(props.slices)
    .filter(isElement)
    .map((node, index) => ({ label: text(node.props.label), amount: Math.max(0, Number(node.props.value) || 0), color: pick(node.props.tone, index) }));
  const first = stages[0]?.amount ?? 0;
  return (
    <Frame
      title={props.title}
      keys={[]}
      table={{ head: ["", "Value", "% of first", "% of previous"], rows: stages.map((stage, index) => [stage.label, value(stage.amount, props.unit), percentText(stage.amount, first), index === 0 ? "" : percentText(stage.amount, stages[index - 1]?.amount ?? 0)]) }}
      summary={`funnel ${text(props.title)}: ${stages.map((stage) => stage.label).join(", ")}`}
    >
      {(width) => (
        <View style={{ gap: GAP.s }}>
          {stages.map((stage, index) => {
            const ratio = first > 0 ? Math.max(0.03, stage.amount / first) : 0;
            const previous = index === 0 ? null : (stages[index - 1] as { amount: number }).amount;
            return (
              <View key={index} accessibilityLabel={`${stage.label}: ${value(stage.amount, props.unit)}, ${percentText(stage.amount, first)} of first`} style={{ gap: 3 }}>
                <View style={{ flexDirection: "row", alignItems: "baseline", gap: GAP.s, ...bidi.row(stage.label) }}>
                  <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: FONT.s + 1, ...bidi.text(stage.label) }}>{stage.label}</Text>
                  <Text style={{ color: colors.foreground, fontSize: FONT.s + 1, fontWeight: "600", fontFamily: MONO, ...LTR_TEXT }}>{value(stage.amount, props.unit)}</Text>
                  <Text style={{ minWidth: 70, textAlign: "right", color: colors.foregroundMuted, fontSize: FONT.s, fontFamily: MONO, writingDirection: "ltr" }}>
                    {index === 0 ? "100%" : `${percentText(stage.amount, first)} · ${previous ? `-${100 - Math.round((stage.amount / previous) * 100)}%` : ""}`}
                  </Text>
                </View>
                <View style={{ width, height: FUNNEL_BAR_H, alignItems: "center" }}>
                  <View style={{ width: width * ratio, height: FUNNEL_BAR_H, borderRadius: 4, backgroundColor: stage.color }} />
                </View>
              </View>
            );
          })}
        </View>
      )}
    </Frame>
  );
}

export function Waterfall({ props }: NodeProps) {
  const { colors } = useUiEnv();
  const steps = list(props.steps)
    .filter(isElement)
    .map((node) => ({ label: text(node.props.label), amount: Number(node.props.value) || 0, total: node.props.total === true }));
  const bars = waterfall(steps.map((step) => ({ value: step.amount, total: step.total })));
  const edges = bars.flatMap((bar) => [bar.start, bar.end]);
  const scale = niceScale(Math.min(0, ...edges), Math.max(0, ...edges));
  const [active, setActive] = useState<number | null>(null);
  const colorOf = (index: number) => {
    const bar = bars[index] as { start: number; end: number; total: boolean };
    return bar.total ? colors.accent : bar.end >= bar.start ? colors.statusSuccess : colors.statusDanger;
  };
  const signed = (v: number) => `${v > 0 ? "+" : ""}${value(v, props.unit)}`;
  const readout: Readout | null =
    active === null
      ? null
      : { label: steps[active]?.label ?? "", rows: [{ color: colorOf(active), name: steps[active]?.total ? "total" : "change", value: steps[active]?.total ? value(bars[active]?.end ?? 0, props.unit) : signed(steps[active]?.amount ?? 0) }, ...(steps[active]?.total ? [] : [{ color: colors.foregroundMuted, name: "running", value: value(bars[active]?.end ?? 0, props.unit) }])] };
  return (
    <Frame
      title={props.title}
      keys={[]}
      table={{ head: ["", "Change", "Running"], rows: steps.map((step, index) => [step.label, step.total ? "total" : signed(step.amount), value(bars[index]?.end ?? 0, props.unit)]) }}
      summary={`waterfall ${text(props.title)}: ${steps.map((step) => step.label).join(", ")}`}
    >
      {(width) => (
        <CategoryPlot width={width} scale={scale} rows={steps.map((step) => step.label)} {...(props.unit ? { unit: text(props.unit) } : {})} readout={readout} active={active} onActive={setActive}>
          {(plotW, toY) => {
            const slot = plotW / Math.max(1, steps.length);
            const barW = Math.min(40, Math.max(6, slot * 0.6));
            return bars.map((bar, index) => {
              const top = toY(Math.max(bar.start, bar.end));
              const bottom = toY(Math.min(bar.start, bar.end));
              const left = slot * index + (slot - barW) / 2;
              const next = bars[index + 1];
              return (
                <View key={index} pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, width: plotW, height: PLOT_H }}>
                  <View style={{ position: "absolute", left, width: barW, top, height: Math.max(2, bottom - top), borderRadius: 3, backgroundColor: colorOf(index), opacity: active === null || active === index ? 1 : 0.5 }} />
                  {next ? <View style={{ position: "absolute", left: left + barW, width: slot - barW, top: toY(bar.end), height: 1, backgroundColor: colors.foregroundMuted, opacity: 0.5 }} /> : null}
                </View>
              );
            });
          }}
        </CategoryPlot>
      )}
    </Frame>
  );
}

export function Histogram({ props }: NodeProps) {
  const { colors } = useUiEnv();
  const bins = histogram(numbers(props.values), props.bins === undefined ? undefined : Number(props.bins));
  const total = bins.counts.reduce((sum, count) => sum + count, 0);
  const scale = niceScale(0, Math.max(1, ...bins.counts));
  const [active, setActive] = useState<number | null>(null);
  const range = (index: number) => `${formatCompact(Number((bins.edges[index] as number).toPrecision(3)))} – ${formatCompact(Number((bins.edges[index + 1] as number).toPrecision(3)))}${text(props.unit)}`;
  const rows = bins.counts.map((_, index) => formatCompact(Number((bins.edges[index] as number).toPrecision(2))));
  return (
    <Frame
      title={props.title}
      keys={[]}
      table={{ head: [text(props.xLabel) || "Range", "Count", "%"], rows: bins.counts.map((count, index) => [range(index), String(count), percentText(count, total)]) }}
      summary={`histogram ${text(props.title)}: ${total} values in ${bins.counts.length} bins`}
    >
      {(width) => (
        <CategoryPlot
          width={width}
          scale={scale}
          rows={rows}
          readout={active === null ? null : { label: range(active), rows: [{ color: colors.accent, name: percentText(bins.counts[active] as number, total), value: String(bins.counts[active]) }] }}
          active={active}
          onActive={setActive}
        >
          {(plotW, toY) => {
            const slot = plotW / bins.counts.length;
            return bins.counts.map((count, index) => (
              <View key={index} pointerEvents="none" style={{ position: "absolute", left: slot * index + 0.5, width: Math.max(1, slot - 1), top: toY(count), height: Math.max(count > 0 ? 1 : 0, PLOT_H - toY(count)), borderTopLeftRadius: 2, borderTopRightRadius: 2, backgroundColor: colors.accent, opacity: active === null || active === index ? 1 : 0.5 }} />
            ));
          }}
        </CategoryPlot>
      )}
    </Frame>
  );
}

export function BoxPlot({ props }: NodeProps) {
  const { colors, pick } = useChartPalette();
  const groups = list(props.groups)
    .filter(isElement)
    .map((node, index) => ({ name: text(node.props.name), color: pick(node.props.tone, index), stats: boxStats(numbers(node.props.values)), count: numbers(node.props.values).length }));
  const extremes = groups.flatMap((group) => (group.stats ? [group.stats.min, group.stats.max, ...group.stats.outliers] : []));
  const scale = niceScale(Math.min(...extremes, 0) > 0 ? Math.min(...extremes) : Math.min(0, ...extremes), Math.max(0, ...extremes));
  const [active, setActive] = useState<number | null>(null);
  const unit = text(props.unit);
  const shown = active === null ? undefined : groups[active];
  const readout: Readout | null =
    shown?.stats
      ? { label: `${shown.name} (n=${shown.count})`, rows: [["max", shown.stats.max], ["q3", shown.stats.q3], ["median", shown.stats.median], ["q1", shown.stats.q1], ["min", shown.stats.min]].map(([name, v]) => ({ color: shown.color, name: String(name), value: value(v as number, unit) })).concat(shown.stats.outliers.length ? [{ color: colors.foregroundMuted, name: "outliers", value: String(shown.stats.outliers.length) }] : []) }
      : null;
  return (
    <Frame
      title={props.title}
      keys={[]}
      table={{ head: ["", "Min", "Q1", "Median", "Q3", "Max", "Outliers"], rows: groups.map((group) => (group.stats ? [group.name, value(group.stats.min, unit), value(group.stats.q1, unit), value(group.stats.median, unit), value(group.stats.q3, unit), value(group.stats.max, unit), String(group.stats.outliers.length)] : [group.name, "", "", "", "", "", ""])) }}
      summary={`box plot ${text(props.title)}: ${groups.map((group) => group.name).join(", ")}`}
    >
      {(width) => (
        <CategoryPlot width={width} scale={scale} rows={groups.map((group) => group.name)} {...(unit ? { unit } : {})} readout={readout} active={active} onActive={setActive}>
          {(plotW, toY) => {
            const slot = plotW / Math.max(1, groups.length);
            const boxW = Math.min(44, Math.max(10, slot * 0.5));
            return groups.map((group, index) => {
              const stats = group.stats;
              if (!stats) return null;
              const center = slot * index + slot / 2;
              const dim = active !== null && active !== index ? 0.5 : 1;
              return (
                <View key={index} pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, width: plotW, height: PLOT_H, opacity: dim }}>
                  <View style={{ position: "absolute", left: center - 0.5, width: 1, top: toY(stats.max), height: Math.max(1, toY(stats.min) - toY(stats.max)), backgroundColor: group.color }} />
                  {[stats.max, stats.min].map((cap) => <View key={cap} style={{ position: "absolute", left: center - boxW / 4, width: boxW / 2, top: toY(cap), height: 1, backgroundColor: group.color }} />)}
                  <View style={{ position: "absolute", left: center - boxW / 2, width: boxW, top: toY(stats.q3), height: Math.max(2, toY(stats.q1) - toY(stats.q3)), borderRadius: 3, borderWidth: 1.5, borderColor: group.color, backgroundColor: mixColor(colors.surface1, group.color, 0.3) }} />
                  <View style={{ position: "absolute", left: center - boxW / 2, width: boxW, top: toY(stats.median) - 1, height: 2.5, backgroundColor: group.color }} />
                  {stats.outliers.map((outlier, k) => <Dot key={k} x={center} y={toY(outlier)} color={group.color} size={7} ring={colors.surface1} />)}
                </View>
              );
            });
          }}
        </CategoryPlot>
      )}
    </Frame>
  );
}

export function Candlestick({ props }: NodeProps) {
  const { colors } = useUiEnv();
  const labels = list(props.labels).map(text);
  const candles = list(props.candles).map(numbers).filter((candle) => candle.length >= 4);
  const lows = candles.map((candle) => candle[2] as number);
  const highs = candles.map((candle) => candle[1] as number);
  const scale = niceScale(Math.min(...lows), Math.max(...highs));
  const [active, setActive] = useState<number | null>(null);
  const rows = candles.map((_, index) => labels[index] ?? String(index + 1));
  const unit = text(props.unit);
  const up = (candle: number[]) => (candle[3] as number) >= (candle[0] as number);
  const shown = active === null ? undefined : candles[active];
  const readout: Readout | null = shown
    ? { label: rows[active as number] ?? "", rows: [["open", 0], ["high", 1], ["low", 2], ["close", 3]].map(([name, at]) => ({ color: up(shown) ? colors.statusSuccess : colors.statusDanger, name: String(name), value: value(shown[at as number] as number, unit) })) }
    : null;
  return (
    <Frame
      title={props.title}
      keys={[]}
      table={{ head: ["", "Open", "High", "Low", "Close"], rows: candles.map((candle, index) => [rows[index] ?? "", ...candle.slice(0, 4).map((v) => value(v, unit))]) }}
      summary={`candlestick ${text(props.title)}: ${candles.length} periods`}
    >
      {(width) => (
        <CategoryPlot width={width} scale={scale} rows={rows} {...(unit ? { unit } : {})} readout={readout} active={active} onActive={setActive}>
          {(plotW, toY) => {
            const slot = plotW / Math.max(1, candles.length);
            const bodyW = Math.min(18, Math.max(3, slot * 0.6));
            return candles.map((candle, index) => {
              const color = up(candle) ? colors.statusSuccess : colors.statusDanger;
              const center = slot * index + slot / 2;
              const top = toY(Math.max(candle[0] as number, candle[3] as number));
              const bottom = toY(Math.min(candle[0] as number, candle[3] as number));
              return (
                <View key={index} pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, width: plotW, height: PLOT_H, opacity: active === null || active === index ? 1 : 0.5 }}>
                  <View style={{ position: "absolute", left: center - 0.5, width: 1, top: toY(candle[1] as number), height: Math.max(1, toY(candle[2] as number) - toY(candle[1] as number)), backgroundColor: color }} />
                  <View style={{ position: "absolute", left: center - bodyW / 2, width: bodyW, top, height: Math.max(2, bottom - top), borderRadius: 2, backgroundColor: color }} />
                </View>
              );
            });
          }}
        </CategoryPlot>
      )}
    </Frame>
  );
}

export function RadarChart({ props }: NodeProps) {
  const { colors, pick } = useChartPalette();
  const axes = list(props.axes).map(text);
  const series = list(props.series)
    .filter(isElement)
    .map((node, index) => ({ name: text(node.props.name), color: pick(node.props.tone, index), values: numbers(node.props.values) }));
  const ceiling = props.max === undefined ? Math.max(1, ...series.flatMap((entry) => entry.values)) : Number(props.max) || 1;
  const [active, setActive] = useState<number | null>(null);
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const toggle = (index: number) =>
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else if (series.length - next.size > 1) next.add(index);
      return next;
    });
  return (
    <Frame
      title={props.title}
      keys={series.map((entry) => ({ name: entry.name, color: entry.color, shape: "line" as const }))}
      hidden={hidden}
      onToggle={toggle}
      table={{ head: ["", ...series.map((entry) => entry.name)], rows: axes.map((axis, index) => [axis, ...series.map((entry) => value(entry.values[index] ?? 0, ""))]) }}
      summary={`radar chart ${text(props.title)}: ${axes.join(", ")}`}
    >
      {(width) => {
        const size = Math.min(width, 300);
        const radius = size / 2 - RADAR_LABEL / 2 + 6;
        const cx = width / 2;
        const cy = size / 2;
        const at = (index: number, fraction: number) => {
          const point = radarPoint(index, axes.length, radius * fraction);
          return { x: cx + point.x, y: cy + point.y };
        };
        const polygon = (fractions: number[], color: string, thickness: number, key: string) =>
          fractions.map((fraction, index) => {
            const a = at(index, fraction);
            const b = at((index + 1) % axes.length, fractions[(index + 1) % axes.length] as number);
            return <Line key={`${key}-${index}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} color={color} thickness={thickness} />;
          });
        const visible = series.filter((_, index) => !hidden.has(index));
        const readout: Readout | null = active === null ? null : { label: axes[active] ?? "", rows: visible.map((entry) => ({ color: entry.color, name: entry.name, value: value(entry.values[active] ?? 0, "") })) };
        return (
          <View style={{ height: size, width }}>
            {[0.25, 0.5, 0.75, 1].map((ring) => polygon(axes.map(() => ring), colors.border, 1, `ring-${ring}`))}
            {axes.map((_, index) => {
              const end = at(index, 1);
              return <Line key={`spoke-${index}`} x1={cx} y1={cy} x2={end.x} y2={end.y} color={colors.border} thickness={1} />;
            })}
            {visible.map((entry, seriesIndex) => polygon(axes.map((_, index) => Math.min(1, Math.max(0, (entry.values[index] ?? 0) / ceiling))), entry.color, 2, `s-${seriesIndex}`))}
            {visible.map((entry, seriesIndex) =>
              axes.map((_, index) => {
                const p = at(index, Math.min(1, Math.max(0, (entry.values[index] ?? 0) / ceiling)));
                return <Dot key={`d-${seriesIndex}-${index}`} x={p.x} y={p.y} color={entry.color} size={active === index ? 11 : 8} ring={colors.surface1} />;
              }),
            )}
            {axes.map((axis, index) => {
              const p = at(index, 1.0);
              const out = radarPoint(index, axes.length, 1);
              const labelX = p.x + out.x * 14 - RADAR_LABEL / 2 + (out.x > 0.3 ? RADAR_LABEL / 2 - 4 : out.x < -0.3 ? -RADAR_LABEL / 2 + 4 : 0);
              return (
                <Pressable
                  key={`l-${index}`}
                  accessibilityRole="button"
                  onHoverIn={() => setActive(index)}
                  onHoverOut={() => setActive((now) => (now === index ? null : now))}
                  onPress={() => setActive(active === index ? null : index)}
                  hitSlop={6}
                  style={{ position: "absolute", left: Math.max(0, Math.min(width - RADAR_LABEL, labelX)), top: p.y + out.y * 12 - 8, width: RADAR_LABEL, alignItems: "center" }}
                >
                  <Text numberOfLines={1} style={{ color: active === index ? colors.foreground : colors.foregroundMuted, fontSize: FONT.s, fontWeight: active === index ? "600" : "400" }}>{axis}</Text>
                </Pressable>
              );
            })}
            {readout ? <ReadoutCard readout={readout} style={{ top: 0, left: 0 }} /> : null}
          </View>
        );
      }}
    </Frame>
  );
}

export function CalendarHeatmap({ props }: NodeProps) {
  const { colors } = useUiEnv();
  const bidi = useBidi();
  const days = list(props.days).map(text);
  const amounts = numbers(props.values);
  const entries = days.map((day, index) => ({ day, time: parseTime(day), amount: amounts[index] ?? 0 })).filter((entry) => !Number.isNaN(entry.time));
  const first = Math.min(...entries.map((entry) => entry.time));
  const high = Math.max(...entries.map((entry) => entry.amount), 1e-9);
  const placed = entries.map((entry) => ({ ...entry, ...calendarCell(entry.time, first) }));
  const weeks = Math.max(1, ...placed.map((entry) => entry.week + 1));
  const order = placed.map((entry) => entry.week * 7 + entry.row);
  const firstOrder = Math.min(...order);
  const lastOrder = Math.max(...order);
  const byCell = new Map(placed.map((entry) => [`${entry.week}:${entry.row}`, entry]));
  const [active, setActive] = useState<string | null>(null);
  const current = active === null ? undefined : byCell.get(active);
  const shade = (amount: number) => (amount <= 0 ? colors.surface2 : mixColor(colors.surface2, colors.accent, 0.3 + 0.7 * (amount / high)));
  const months = new Map<number, string>();
  let lastMonth = "";
  for (const entry of [...placed].sort((x, y) => x.time - y.time)) {
    const date = new Date(entry.time);
    const month = `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
    if (month === lastMonth) continue;
    lastMonth = month;
    if (!months.has(entry.week)) months.set(entry.week, date.toLocaleString("en-US", { month: "short", timeZone: "UTC" }));
  }
  return (
    <Frame
      title={props.title}
      keys={[]}
      table={{ head: ["Day", "Value"], rows: entries.map((entry) => [entry.day, value(entry.amount, props.unit)]) }}
      summary={`calendar heatmap ${text(props.title)}: ${entries.length} days`}
    >
      {(width) => {
        const cell = Math.min(CALENDAR_MAX_CELL, Math.max(CALENDAR_MIN_CELL, Math.floor((width - CALENDAR_GUTTER) / weeks)));
        const grid = (
          <View style={{ flexDirection: "row" }}>
            <View style={{ width: CALENDAR_GUTTER, paddingTop: 16 }}>
              {WEEKDAYS.map((name, row) => (
                <Text key={row} style={{ height: cell, color: colors.foregroundMuted, fontSize: FONT.s - 2, writingDirection: "ltr" }}>{name}</Text>
              ))}
            </View>
            <View>
              <View style={{ height: 16 }}>
                {[...months].map(([week, name]) => (
                  <Text key={week} numberOfLines={1} style={{ position: "absolute", left: week * cell, color: colors.foregroundMuted, fontSize: FONT.s - 1, writingDirection: "ltr" }}>{name}</Text>
                ))}
              </View>
              <View style={{ flexDirection: "row" }}>
                {Array.from({ length: weeks }, (_, week) => (
                  <View key={week}>
                    {Array.from({ length: 7 }, (_, row) => {
                      const entry = byCell.get(`${week}:${row}`);
                      const key = `${week}:${row}`;
                      return (
                        <Pressable
                          key={row}
                          disabled={!entry}
                          accessibilityRole="button"
                          accessibilityLabel={entry ? `${entry.day}: ${value(entry.amount, props.unit)}` : undefined}
                          onHoverIn={() => setActive(key)}
                          onHoverOut={() => setActive((now) => (now === key ? null : now))}
                          onPress={() => setActive(active === key ? null : key)}
                          style={{ width: cell, height: cell, padding: 1 }}
                        >
                          {entry || (week * 7 + row >= firstOrder && week * 7 + row <= lastOrder) ? (
                            <View style={{ flex: 1, borderRadius: 2, backgroundColor: entry ? shade(entry.amount) : colors.surface2, opacity: entry ? 1 : 0.5, borderWidth: active === key ? 1.5 : 0, borderColor: colors.foreground }} />
                          ) : null}
                        </Pressable>
                      );
                    })}
                  </View>
                ))}
              </View>
            </View>
          </View>
        );
        return (
          <View style={{ gap: GAP.s }}>
            {CALENDAR_GUTTER + weeks * cell > width ? <ScrollView horizontal showsHorizontalScrollIndicator={false}>{grid}</ScrollView> : grid}
            <View style={{ flexDirection: "row", alignItems: "center", gap: GAP.s, ...bidi.row("") }}>
              <Text style={{ color: colors.foregroundMuted, fontSize: FONT.s, writingDirection: "ltr" }}>Less</Text>
              {[0, 0.25, 0.5, 0.75, 1].map((step) => <Key key={step} color={shade(step * high)} shape="box" />)}
              <Text style={{ color: colors.foregroundMuted, fontSize: FONT.s, writingDirection: "ltr" }}>More</Text>
              <Text numberOfLines={1} style={{ flex: 1, textAlign: "right", color: colors.foreground, fontSize: FONT.s, fontWeight: "600", writingDirection: "ltr" }}>
                {current ? `${current.day} · ${value(current.amount, props.unit)}` : ""}
              </Text>
            </View>
          </View>
        );
      }}
    </Frame>
  );
}

