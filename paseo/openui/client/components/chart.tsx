import { Icon } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  categorical,
  formatCompact,
  labelIndices,
  linearFit,
  luminance,
  niceScale,
  pieAngles,
  pieHit,
  percentOfTotal,
  pointX,
  type Scale,
  segment,
  stackValues,
} from "../../shared/chart";
import { LTR_TEXT, useBidi } from "../bidi";
import { isElement } from "../runtime";
import { type Colors, FONT, GAP, MONO, RADIUS, type Tone, toneColor, useUiEnv, wash } from "../tokens";
import type { NodeProps } from "./types";

/** Charts are drawn with Views (rotated boxes for lines and pie slivers): plugins have no SVG. */

export const PLOT_H = 168;
export const GUTTER_Y = 40;
export const GUTTER_X = 22;
const AREA_STEP = 2;
const PIE_SLIVERS = 360;

interface SeriesData {
  name: string;
  color: string;
  values: number[];
}

export interface Readout {
  label: string;
  rows: Array<{ color: string; name: string; value: string }>;
}

export function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function numbers(value: unknown): number[] {
  return list(value).map((entry) => (Number.isFinite(Number(entry)) ? Number(entry) : 0));
}

export function useChartPalette() {
  const { colors } = useUiEnv();
  const palette = categorical(luminance(colors.surface0) < 0.5);
  const pick = (tone: unknown, index: number) =>
    tone && tone !== "default" ? toneColor(colors, tone as Tone) : (palette[index % palette.length] as string);
  return { colors, pick };
}

function readSeries(source: unknown, pick: (tone: unknown, index: number) => string): SeriesData[] {
  return list(source)
    .filter(isElement)
    .map((node, index) => ({
      name: text(node.props.name),
      color: pick(node.props.tone, index),
      values: numbers(node.props.values),
    }));
}

export function value(v: number, unit: unknown): string {
  return `${Number(v.toFixed(2)).toLocaleString("en-US")}${text(unit)}`;
}

export function useWidth(): [number, (event: { nativeEvent: { layout: { width: number } } }) => void] {
  const [width, setWidth] = useState(0);
  return [width, (event) => setWidth(Math.floor(event.nativeEvent.layout.width))];
}

export function Key({ color, shape }: { color: string; shape: "line" | "dot" | "box" }) {
  return (
    <View
      style={{
        width: shape === "line" ? 14 : shape === "dot" ? 8 : 10,
        height: shape === "line" ? 3 : shape === "dot" ? 8 : 10,
        borderRadius: shape === "dot" ? 4 : 2,
        backgroundColor: color,
      }}
    />
  );
}

export function ReadoutCard({ readout, style }: { readout: Readout; style: object }) {
  const { colors } = useUiEnv();
  const bidi = useBidi();
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        minWidth: 120,
        maxWidth: 190,
        padding: GAP.s,
        gap: 3,
        borderRadius: RADIUS.s,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface2,
        ...style,
      }}
    >
      <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: FONT.s, ...bidi.text(readout.label) }}>{readout.label}</Text>
      {readout.rows.map((row, index) => (
        <View key={index} style={{ flexDirection: "row", alignItems: "center", gap: 6, ...bidi.row(row.name) }}>
          <Key color={row.color} shape="line" />
          <Text style={{ color: colors.foreground, fontSize: FONT.s + 1, fontWeight: "600", fontFamily: MONO, ...LTR_TEXT }}>{row.value}</Text>
          <Text numberOfLines={1} style={{ flex: 1, color: colors.foregroundMuted, fontSize: FONT.s, ...bidi.text(row.name) }}>{row.name}</Text>
        </View>
      ))}
    </View>
  );
}

interface FrameProps {
  title: unknown;
  keys: Array<{ name: string; color: string; shape: "line" | "dot" | "box" }>;
  hidden?: Set<number>;
  onToggle?: (index: number) => void;
  table: { head: string[]; rows: string[][] };
  summary: string;
  children: (width: number) => ReactNode;
}

/** Title, a data-table toggle, the plot, and a legend whose entries hide and show series. */
export function Frame({ title, keys, hidden, onToggle, table, summary, children }: FrameProps) {
  const { colors } = useUiEnv();
  const bidi = useBidi();
  const [asTable, setAsTable] = useState(false);
  const [width, onLayout] = useWidth();
  return (
    <View style={{ gap: GAP.s }} accessibilityLabel={summary}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: GAP.s, ...bidi.row(text(title)) }}>
        <Text style={{ flex: 1, color: colors.foreground, fontSize: FONT.m, fontWeight: "600", ...bidi.text(text(title)) }}>{text(title)}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={asTable ? "Show chart" : "Show data table"} hitSlop={8} onPress={() => setAsTable((on) => !on)}>
          <Icon name={asTable ? "ChartLine" : "Table"} size={16} color={colors.foregroundMuted} />
        </Pressable>
      </View>
      <View onLayout={onLayout} style={{ direction: "ltr" }}>
        {width === 0 ? null : asTable ? <DataTable head={table.head} rows={table.rows} /> : children(width)}
      </View>
      {keys.length >= 2 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: GAP.m, ...bidi.row(keys.map((key) => key.name).join(" ")) }}>
          {keys.map((key, index) => (
            <Pressable
              key={index}
              accessibilityRole="button"
              accessibilityState={{ selected: !hidden?.has(index) }}
              onPress={() => onToggle?.(index)}
              style={{ flexDirection: "row", alignItems: "center", gap: 6, opacity: hidden?.has(index) ? 0.4 : 1, ...bidi.row(key.name) }}
            >
              <Key color={key.color} shape={key.shape} />
              <Text style={{ color: colors.foreground, fontSize: FONT.s + 1, ...bidi.text(key.name) }}>{key.name}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function DataTable({ head, rows }: { head: string[]; rows: string[][] }) {
  const { colors } = useUiEnv();
  return (
    <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: RADIUS.s, overflow: "hidden" }}>
      {[head, ...rows].map((row, rowIndex) => (
        <View key={rowIndex} style={{ flexDirection: "row", borderTopWidth: rowIndex === 0 ? 0 : 1, borderTopColor: colors.border, backgroundColor: rowIndex === 0 ? colors.surface1 : undefined }}>
          {row.map((cellText, index) => (
            <Text key={index} numberOfLines={1} style={{ flex: 1, padding: GAP.s, color: rowIndex === 0 ? colors.foreground : colors.foregroundMuted, fontSize: FONT.s, fontWeight: rowIndex === 0 ? "600" : "400" }}>
              {cellText}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

function useHidden(): [Set<number>, (index: number, total: number) => void] {
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  return [
    hidden,
    (index, total) =>
      setHidden((current) => {
        const next = new Set(current);
        if (next.has(index)) next.delete(index);
        else if (total - next.size > 1) next.add(index);
        return next;
      }),
  ];
}

export function Axis({ scale, plotW, colors, unit }: { scale: Scale; plotW: number; colors: Colors; unit?: string }) {
  const span = scale.max - scale.min || 1;
  return (
    <>
      {scale.ticks.map((tick) => {
        const y = PLOT_H - ((tick - scale.min) / span) * PLOT_H;
        return (
          <View key={tick} pointerEvents="none" style={{ position: "absolute", left: 0, top: y - 7, right: 0, height: 14 }}>
            <Text style={{ position: "absolute", left: 0, width: GUTTER_Y - 6, textAlign: "right", color: colors.foregroundMuted, fontSize: FONT.s - 1, fontFamily: MONO, writingDirection: "ltr" }}>
              {`${formatCompact(tick)}${unit ?? ""}`}
            </Text>
            <View style={{ position: "absolute", left: GUTTER_Y, top: 7, width: plotW, height: 1, backgroundColor: colors.border, opacity: 0.6 }} />
          </View>
        );
      })}
    </>
  );
}

export function XLabels({ labels, plotW, colors, centered }: { labels: string[]; plotW: number; colors: Colors; centered?: boolean }) {
  const total = GUTTER_Y + plotW;
  const shown = labelIndices(labels.length, Math.max(2, Math.floor(plotW / 64)));
  const slot = centered ? plotW / labels.length : 0;
  return (
    <>
      {shown.map((index) => {
        const x = centered ? slot * index + slot / 2 : pointX(index, labels.length, plotW);
        return (
          <Text
            key={index}
            numberOfLines={1}
            style={{ position: "absolute", top: PLOT_H + 6, left: Math.min(Math.max(0, GUTTER_Y + x - 28), total - 56), width: 56, textAlign: "center", color: colors.foregroundMuted, fontSize: FONT.s - 1, writingDirection: "ltr" }}
          >
            {labels[index]}
          </Text>
        );
      })}
    </>
  );
}

export function Line({ x1, y1, x2, y2, color, thickness = 2 }: { x1: number; y1: number; x2: number; y2: number; color: string; thickness?: number }) {
  const s = segment(x1, y1, x2, y2, thickness);
  return (
    <View
      pointerEvents="none"
      style={{ position: "absolute", left: s.left, top: s.top, width: s.width, height: s.height, borderRadius: thickness / 2, backgroundColor: color, transform: [{ rotate: `${s.rotate}rad` }] }}
    />
  );
}

export function Dot({ x, y, color, size, ring }: { x: number; y: number; color: string; size: number; ring: string }) {
  return (
    <View
      pointerEvents="none"
      style={{ position: "absolute", left: x - size / 2, top: y - size / 2, width: size, height: size, borderRadius: size / 2, backgroundColor: color, borderWidth: 2, borderColor: ring }}
    />
  );
}

/** One index-aligned hit strip per category: hover on desktop, tap on phones. */
export function Zones({ count, plotW, centered, active, onActive }: { count: number; plotW: number; centered?: boolean; active: number | null; onActive: (index: number | null) => void }) {
  const slot = centered ? plotW / count : count > 1 ? plotW / (count - 1) : plotW;
  return (
    <>
      {Array.from({ length: count }, (_, index) => {
        const center = centered ? slot * index + slot / 2 : pointX(index, count, plotW);
        const left = Math.max(0, center - slot / 2);
        const right = Math.min(plotW, center + slot / 2);
        return (
          <Pressable
            key={index}
            accessibilityRole="button"
            onHoverIn={() => onActive(index)}
            onHoverOut={() => onActive(active === index ? null : active)}
            onPress={() => onActive(active === index ? null : index)}
            style={{ position: "absolute", left, width: right - left, top: 0, height: PLOT_H }}
          />
        );
      })}
    </>
  );
}

export function tooltipPlacement(x: number, plotW: number): object {
  return x > plotW / 2 ? { top: 0, right: plotW - x + 10 } : { top: 0, left: x + 10 };
}

function seriesTable(labels: string[], series: SeriesData[], unit: unknown) {
  return {
    head: ["", ...series.map((entry) => entry.name)],
    rows: labels.map((label, index) => [label, ...series.map((entry) => value(entry.values[index] ?? 0, unit))]),
  };
}

/** Each series' values as a percent of the category total, for percent-stacked charts. */
function asPercent(series: SeriesData[]): SeriesData[] {
  const shares = percentOfTotal(series.map((entry) => entry.values));
  return series.map((entry, index) => ({ ...entry, values: shares[index] as number[] }));
}

function XYChart({ props, kind }: NodeProps & { kind: "line" | "area" }) {
  const { colors, pick } = useChartPalette();
  const percent = kind === "area" && props.percent === true;
  const unit = percent ? "%" : props.unit;
  const all = percent ? asPercent(readSeries(props.series, pick)) : readSeries(props.series, pick);
  const labels = list(props.labels).map(text);
  const count = Math.max(labels.length, ...all.map((entry) => entry.values.length));
  const [hidden, toggle] = useHidden();
  const [active, setActive] = useState<number | null>(null);
  const stacked = kind === "area" && (props.stacked === true || percent);
  const filled = kind === "area" || props.area === true;
  const shown = all.filter((_, index) => !hidden.has(index));
  const visible = percent ? asPercent(shown) : shown;
  const stack = stacked ? stackValues(visible.map((entry) => entry.values)) : null;
  const flat = stack ? stack.flatMap((row) => row.map((cellValue) => cellValue.high)) : visible.flatMap((entry) => entry.values);
  const scale = niceScale(Math.min(0, ...flat), Math.max(0, ...flat));
  const span = scale.max - scale.min || 1;
  const toY = (v: number) => PLOT_H - ((v - scale.min) / span) * PLOT_H;
  const rows = labels.length > 0 ? labels : Array.from({ length: count }, (_, index) => String(index + 1));

  return (
    <Frame
      title={props.title}
      keys={all.map((entry) => ({ name: entry.name, color: entry.color, shape: filled ? "box" : "line" }))}
      hidden={hidden}
      onToggle={(index) => toggle(index, all.length)}
      table={seriesTable(rows, all, unit)}
      summary={`${kind} chart ${text(props.title)}: ${all.map((entry) => entry.name).join(", ")}`}
    >
      {(width) => {
        const plotW = width - GUTTER_Y;
        const step = AREA_STEP;
        const at = (values: number[], index: number) => ({ x: pointX(index, count, plotW), y: toY(values[index] ?? 0) });
        const markers = count <= 31;
        const activeX = active === null ? null : pointX(active, count, plotW);
        const readout: Readout | null =
          active === null
            ? null
            : {
                label: rows[active] ?? "",
                rows: visible.map((entry) => ({ color: entry.color, name: entry.name, value: value(entry.values[active] ?? 0, unit) })),
              };
        return (
          <View style={{ height: PLOT_H + GUTTER_X }}>
            <Axis scale={scale} plotW={plotW} colors={colors} {...(unit ? { unit: text(unit) } : {})} />
            <View style={{ position: "absolute", left: GUTTER_Y, top: 0, width: plotW, height: PLOT_H }}>
              {filled
                ? visible.map((entry, seriesIndex) =>
                    Array.from({ length: Math.ceil(plotW / step) }, (_, column) => {
                      const x = column * step;
                      const position = count > 1 ? (x / plotW) * (count - 1) : 0;
                      const i0 = Math.min(count - 1, Math.floor(position));
                      const i1 = Math.min(count - 1, i0 + 1);
                      const t = position - i0;
                      const lerp = (a: number, b: number) => a + (b - a) * t;
                      const high = stack
                        ? lerp(stack[seriesIndex]?.[i0]?.high ?? 0, stack[seriesIndex]?.[i1]?.high ?? 0)
                        : lerp(entry.values[i0] ?? 0, entry.values[i1] ?? 0);
                      const low = stack ? lerp(stack[seriesIndex]?.[i0]?.low ?? 0, stack[seriesIndex]?.[i1]?.low ?? 0) : 0;
                      const top = toY(Math.max(high, scale.min));
                      const bottom = toY(Math.max(low, scale.min));
                      return (
                        <View
                          key={`${seriesIndex}-${column}`}
                          pointerEvents="none"
                          style={{ position: "absolute", left: x, width: step, top, height: Math.max(0, bottom - top), backgroundColor: wash(entry.color, colors.surface1, stacked ? 0.7 : 0.2) }}
                        />
                      );
                    }),
                  )
                : null}
              {visible.map((entry, seriesIndex) => {
                const edge = stack ? (stack[seriesIndex] ?? []).map((cellValue) => cellValue.high) : entry.values;
                return Array.from({ length: Math.max(0, count - 1) }, (_, index) => {
                  const a = at(edge, index);
                  const b = at(edge, index + 1);
                  return <Line key={`${seriesIndex}-${index}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} color={entry.color} />;
                });
              })}
              {markers
                ? visible.map((entry, seriesIndex) => {
                    const edge = stack ? (stack[seriesIndex] ?? []).map((cellValue) => cellValue.high) : entry.values;
                    return Array.from({ length: count }, (_, index) => {
                      const p = at(edge, index);
                      return <Dot key={`${seriesIndex}-${index}`} x={p.x} y={p.y} color={entry.color} size={active === index ? 10 : 8} ring={colors.surface1} />;
                    });
                  })
                : null}
              {activeX === null ? null : <View pointerEvents="none" style={{ position: "absolute", left: activeX, top: 0, width: 1, height: PLOT_H, backgroundColor: colors.foregroundMuted }} />}
              <Zones count={count} plotW={plotW} active={active} onActive={setActive} />
              {readout && activeX !== null ? <ReadoutCard readout={readout} style={tooltipPlacement(activeX, plotW)} /> : null}
            </View>
            <XLabels labels={rows} plotW={plotW} colors={colors} />
          </View>
        );
      }}
    </Frame>
  );
}

export function LineChart(node: NodeProps) {
  return <XYChart {...node} kind="line" />;
}

export function AreaChart(node: NodeProps) {
  return <XYChart {...node} kind="area" />;
}

export function ColumnChart({ props }: NodeProps) {
  const { colors, pick } = useChartPalette();
  const percent = props.percent === true;
  const unit = percent ? "%" : props.unit;
  const all = percent ? asPercent(readSeries(props.series, pick)) : readSeries(props.series, pick);
  const labels = list(props.labels).map(text);
  const count = Math.max(labels.length, ...all.map((entry) => entry.values.length));
  const [hidden, toggle] = useHidden();
  const [active, setActive] = useState<number | null>(null);
  const stacked = props.stacked === true || percent;
  const shown = all.filter((_, index) => !hidden.has(index));
  const visible = percent ? asPercent(shown) : shown;
  const stack = stackValues(visible.map((entry) => entry.values));
  const flat = stacked ? stack.flatMap((row) => row.map((cellValue) => cellValue.high)) : visible.flatMap((entry) => entry.values);
  const scale = niceScale(Math.min(0, ...flat), Math.max(0, ...flat));
  const span = scale.max - scale.min || 1;
  const toY = (v: number) => PLOT_H - ((v - scale.min) / span) * PLOT_H;
  const rows = labels.length > 0 ? labels : Array.from({ length: count }, (_, index) => String(index + 1));

  return (
    <Frame
      title={props.title}
      keys={all.map((entry) => ({ name: entry.name, color: entry.color, shape: "box" }))}
      hidden={hidden}
      onToggle={(index) => toggle(index, all.length)}
      table={seriesTable(rows, all, unit)}
      summary={`column chart ${text(props.title)}: ${all.map((entry) => entry.name).join(", ")}`}
    >
      {(width) => {
        const plotW = width - GUTTER_Y;
        const slot = plotW / Math.max(count, 1);
        const barW = stacked ? Math.min(40, Math.max(6, slot * 0.6)) : Math.min(28, Math.max(4, (slot * 0.7) / Math.max(visible.length, 1) - 2));
        const groupW = stacked ? barW : visible.length * (barW + 2) - 2;
        const readoutX = active === null ? null : slot * active + slot / 2;
        const readout: Readout | null =
          active === null
            ? null
            : { label: rows[active] ?? "", rows: visible.map((entry) => ({ color: entry.color, name: entry.name, value: value(entry.values[active] ?? 0, unit) })) };
        return (
          <View style={{ height: PLOT_H + GUTTER_X }}>
            <Axis scale={scale} plotW={plotW} colors={colors} {...(unit ? { unit: text(unit) } : {})} />
            <View style={{ position: "absolute", left: GUTTER_Y, top: 0, width: plotW, height: PLOT_H }}>
              {active === null ? null : <View pointerEvents="none" style={{ position: "absolute", left: slot * active, width: slot, top: 0, height: PLOT_H, backgroundColor: colors.surface2, opacity: 0.6 }} />}
              {visible.map((entry, seriesIndex) =>
                Array.from({ length: count }, (_, index) => {
                  const v = Math.max(0, entry.values[index] ?? 0);
                  const low = stacked ? (stack[seriesIndex]?.[index]?.low ?? 0) : 0;
                  const high = stacked ? (stack[seriesIndex]?.[index]?.high ?? 0) : v;
                  const top = toY(high);
                  const bottom = toY(low);
                  const left = slot * index + (slot - groupW) / 2 + (stacked ? 0 : seriesIndex * (barW + 2));
                  const isTop = !stacked || seriesIndex === visible.length - 1;
                  const gap = stacked && low > 0 ? 2 : 0;
                  return (
                    <View
                      key={`${seriesIndex}-${index}`}
                      pointerEvents="none"
                      style={{
                        position: "absolute",
                        left,
                        width: barW,
                        top,
                        height: Math.max(0, bottom - top - gap),
                        backgroundColor: entry.color,
                        opacity: active === null || active === index ? 1 : 0.55,
                        ...(isTop ? { borderTopLeftRadius: 4, borderTopRightRadius: 4 } : {}),
                      }}
                    />
                  );
                }),
              )}
              <Zones count={count} plotW={plotW} centered active={active} onActive={setActive} />
              {readout && readoutX !== null ? <ReadoutCard readout={readout} style={tooltipPlacement(readoutX, plotW)} /> : null}
            </View>
            <XLabels labels={rows} plotW={plotW} colors={colors} centered />
          </View>
        );
      }}
    </Frame>
  );
}

export function PieChart({ props }: NodeProps) {
  const { colors, pick } = useChartPalette();
  const bidi = useBidi();
  const nodes = list(props.slices).filter(isElement);
  const values = nodes.map((node) => Number(node.props.value) || 0);
  const names = nodes.map((node) => text(node.props.label));
  const shades = nodes.map((node, index) => pick(node.props.tone, index));
  const total = values.reduce((sum, v) => sum + Math.max(0, v), 0);
  const slices = pieAngles(values);
  const donut = props.donut === true;
  const [active, setActive] = useState<number | null>(null);
  const percent = (index: number) => `${Math.round((slices[index]?.fraction ?? 0) * 100)}%`;

  return (
    <Frame
      title={props.title}
      keys={[]}
      table={{ head: ["", "Value", "%"], rows: names.map((name, index) => [name, value(values[index] ?? 0, props.unit), percent(index)]) }}
      summary={`${donut ? "donut" : "pie"} chart ${text(props.title)}: ${names.join(", ")}`}
    >
      {(width) => {
        const size = Math.min(width, 220);
        const outer = size / 2 - 8;
        const inner = donut ? outer * 0.62 : 0;
        const center = size / 2;
        const gapAngle = 1.2 / outer;
        return (
          <View style={{ gap: GAP.m }}>
            <View style={{ alignSelf: "center", width: size, height: size }}>
              {Array.from({ length: PIE_SLIVERS }, (_, k) => {
                const angle = -Math.PI / 2 + ((k + 0.5) / PIE_SLIVERS) * Math.PI * 2;
                const index = slices.findIndex((slice) => slice.fraction > 0 && angle >= slice.start && angle < slice.end);
                const slice = slices[index];
                if (!slice || angle - slice.start < gapAngle || slice.end - angle < gapAngle) return null;
                const reach = active === index ? outer + 6 : outer;
                const s = segment(center + inner * Math.cos(angle), center + inner * Math.sin(angle), center + reach * Math.cos(angle), center + reach * Math.sin(angle), (2 * Math.PI * reach * 1.7) / PIE_SLIVERS);
                return (
                  <View
                    key={k}
                    pointerEvents="none"
                    style={{ position: "absolute", left: s.left, top: s.top, width: s.width, height: s.height, backgroundColor: shades[index], opacity: active === null || active === index ? 1 : 0.5, transform: [{ rotate: `${s.rotate}rad` }] }}
                  />
                );
              })}
              {donut ? (
                <View pointerEvents="none" style={{ position: "absolute", left: center - inner, top: center - inner, width: inner * 2, height: inner * 2, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 }}>
                  <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: FONT.s, ...bidi.text(active === null ? "" : (names[active] ?? "")) }}>{active === null ? "Total" : names[active]}</Text>
                  <Text style={{ color: colors.foreground, fontSize: FONT.h2, fontWeight: "700", fontFamily: MONO, ...LTR_TEXT }}>{active === null ? value(total, props.unit) : value(values[active] ?? 0, props.unit)}</Text>
                  {active === null ? null : <Text style={{ color: colors.foregroundMuted, fontSize: FONT.s, ...LTR_TEXT }}>{percent(active)}</Text>}
                </View>
              ) : null}
              <Pressable
                accessibilityRole="button"
                style={{ position: "absolute", left: 0, top: 0, width: size, height: size }}
                onPress={(event) => {
                  const hit = pieHit(event.nativeEvent.locationX - center, event.nativeEvent.locationY - center, inner, outer + 6, slices);
                  setActive(hit < 0 || hit === active ? null : hit);
                }}
              />
            </View>
            <View style={{ gap: 2 }}>
              {names.map((name, index) => (
                <Pressable
                  key={index}
                  accessibilityRole="button"
                  onHoverIn={() => setActive(index)}
                  onHoverOut={() => setActive((current) => (current === index ? null : current))}
                  onPress={() => setActive(active === index ? null : index)}
                  style={{ flexDirection: "row", alignItems: "center", gap: GAP.s, paddingVertical: 4, paddingHorizontal: GAP.s, borderRadius: RADIUS.s, backgroundColor: active === index ? colors.surface2 : undefined, ...bidi.row(name) }}
                >
                  <Key color={shades[index] as string} shape="dot" />
                  <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: FONT.s + 1, ...bidi.text(name) }}>{name}</Text>
                  <Text style={{ color: colors.foreground, fontSize: FONT.s + 1, fontWeight: "600", fontFamily: MONO, ...LTR_TEXT }}>{value(values[index] ?? 0, props.unit)}</Text>
                  <Text style={{ width: 40, textAlign: "right", color: colors.foregroundMuted, fontSize: FONT.s, writingDirection: "ltr" }}>{percent(index)}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        );
      }}
    </Frame>
  );
}

export function ScatterChart({ props }: NodeProps) {
  const { colors, pick } = useChartPalette();
  const bidi = useBidi();
  const groups = list(props.groups)
    .filter(isElement)
    .map((node, index) => ({
      name: text(node.props.name),
      color: pick(node.props.tone, index),
      points: list(node.props.points).map((pair) => numbers(pair)).filter((pair) => pair.length >= 2) as number[][],
    }));
  const [hidden, toggle] = useHidden();
  const [active, setActive] = useState<[number, number] | null>(null);
  const visible = groups.filter((_, index) => !hidden.has(index));
  const xs = visible.flatMap((group) => group.points.map((p) => p[0] as number));
  const ys = visible.flatMap((group) => group.points.map((p) => p[1] as number));
  const xScale = niceScale(Math.min(...xs, 0), Math.max(...xs, 1));
  const yScale = niceScale(Math.min(...ys, 0), Math.max(...ys, 1));
  const toY = (v: number) => PLOT_H - ((v - yScale.min) / (yScale.max - yScale.min || 1)) * PLOT_H;
  const sizes = visible.flatMap((group) => group.points.map((p) => p[2])).filter((size): size is number => size !== undefined && size > 0);
  const biggest = Math.max(...sizes, 0);
  const diameter = (p: number[]) => (biggest > 0 && p[2] !== undefined ? 8 + 20 * Math.sqrt(Math.max(0, p[2]) / biggest) : 8);

  return (
    <Frame
      title={props.title}
      keys={groups.map((group) => ({ name: group.name, color: group.color, shape: "dot" }))}
      hidden={hidden}
      onToggle={(index) => toggle(index, groups.length)}
      table={{ head: ["", text(props.xLabel) || "x", text(props.yLabel) || "y"], rows: groups.flatMap((group) => group.points.map((p) => [group.name, value(p[0] as number, ""), value(p[1] as number, "")])) }}
      summary={`scatter chart ${text(props.title)}: ${groups.map((group) => group.name).join(", ")}`}
    >
      {(width) => {
        const plotW = width - GUTTER_Y;
        const toX = (v: number) => ((v - xScale.min) / (xScale.max - xScale.min || 1)) * plotW;
        const point = active ? visible[active[0]]?.points[active[1]] : undefined;
        const activeGroup = active ? visible[active[0]] : undefined;
        return (
          <View style={{ height: PLOT_H + GUTTER_X + 14 }}>
            <Axis scale={yScale} plotW={plotW} colors={colors} />
            <View style={{ position: "absolute", left: GUTTER_Y, top: 0, width: plotW, height: PLOT_H }}>
              {props.trend === true
                ? visible.map((group, groupIndex) => {
                    const fit = linearFit(group.points);
                    const first = Math.min(...group.points.map((p) => p[0] as number));
                    const last = Math.max(...group.points.map((p) => p[0] as number));
                    return fit ? (
                      <Line key={`trend-${groupIndex}`} x1={toX(first)} y1={toY(fit.slope * first + fit.intercept)} x2={toX(last)} y2={toY(fit.slope * last + fit.intercept)} color={group.color} thickness={1.5} />
                    ) : null;
                  })
                : null}
              {visible.map((group, groupIndex) =>
                group.points.map((p, index) => {
                  const x = toX(p[0] as number);
                  const y = toY(p[1] as number);
                  const isActive = active?.[0] === groupIndex && active[1] === index;
                  return (
                    <Pressable
                      key={`${groupIndex}-${index}`}
                      accessibilityRole="button"
                      hitSlop={4}
                      onHoverIn={() => setActive([groupIndex, index])}
                      onHoverOut={() => setActive((current) => (current?.[0] === groupIndex && current[1] === index ? null : current))}
                      onPress={() => setActive(isActive ? null : [groupIndex, index])}
                      style={{ position: "absolute", left: x - Math.max(12, diameter(p) / 2), top: y - Math.max(12, diameter(p) / 2), width: Math.max(24, diameter(p)), height: Math.max(24, diameter(p)), alignItems: "center", justifyContent: "center" }}
                    >
                      <View style={{ width: diameter(p) + (isActive ? 4 : 0), height: diameter(p) + (isActive ? 4 : 0), borderRadius: diameter(p), backgroundColor: biggest > 0 ? wash(group.color, colors.surface1, 0.65) : group.color, borderWidth: biggest > 0 ? 1.5 : 2, borderColor: biggest > 0 ? group.color : colors.surface1 }} />
                    </Pressable>
                  );
                }),
              )}
              {point && activeGroup ? (
                <ReadoutCard
                  readout={{ label: activeGroup.name, rows: [{ color: activeGroup.color, name: text(props.xLabel) || "x", value: value(point[0] as number, "") }, { color: activeGroup.color, name: text(props.yLabel) || "y", value: value(point[1] as number, "") }, ...(point[2] === undefined ? [] : [{ color: activeGroup.color, name: "size", value: value(point[2], "") }])] }}
                  style={tooltipPlacement(toX(point[0] as number), plotW)}
                />
              ) : null}
            </View>
            {xScale.ticks.map((tick) => (
              <Text key={tick} style={{ position: "absolute", top: PLOT_H + 6, left: GUTTER_Y + toX(tick) - 28, width: 56, textAlign: "center", color: colors.foregroundMuted, fontSize: FONT.s - 1, fontFamily: MONO, writingDirection: "ltr" }}>{formatCompact(tick)}</Text>
            ))}
            {props.xLabel ? <Text style={{ position: "absolute", top: PLOT_H + GUTTER_X - 2, left: GUTTER_Y, width: plotW, color: colors.foregroundMuted, fontSize: FONT.s, ...bidi.text(text(props.xLabel)), textAlign: "center" }}>{text(props.xLabel)}</Text> : null}
          </View>
        );
      }}
    </Frame>
  );
}
