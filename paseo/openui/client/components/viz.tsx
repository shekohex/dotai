import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { formatCompact, formatTime, gaugeTone, labelIndices, luminance, mixColor, niceScale, parseTime, segment, treemap } from "../../shared/chart";
import { LTR_TEXT, useBidi } from "../bidi";
import { isElement } from "../runtime";
import { FONT, GAP, MONO, RADIUS, type Tone, toneColor, useUiEnv } from "../tokens";
import { AnimatedIcon } from "./animated-icon";
import { Frame, Key, Line, list, numbers, text, useChartPalette, useWidth, value } from "./chart";
import type { NodeProps } from "./types";

/** Heatmap, Treemap, Gauge, Sparkline, Timeline, Gantt and Spinner. Drawn with Views like the charts. */

const HEAT_GUTTER = 72;
const HEAT_CELL_H = 28;
const TREEMAP_H = 220;
const GAUGE_SLIVERS = 90;
const GAUGE_THICKNESS = 16;
const SPARK_H = 36;
const GANTT_ROW_H = 40;

function readableOn(background: string, light: string, dark: string): string {
  return luminance(background) > 0.45 ? dark : light;
}

function caption(parts: string[]): string {
  return parts.filter(Boolean).join(" · ");
}

export function Heatmap({ props }: NodeProps) {
  const { colors } = useUiEnv();
  const bidi = useBidi();
  const rows = list(props.rows).map(text);
  const columns = list(props.columns).map(text);
  const grid = list(props.values).map(numbers);
  const flat = grid.flat();
  const low = flat.length > 0 ? Math.min(...flat) : 0;
  const high = flat.length > 0 ? Math.max(...flat) : 1;
  const shade = (v: number) => mixColor(colors.surface2, colors.accent, 0.1 + 0.9 * ((v - low) / (high - low || 1)));
  const [active, setActive] = useState<[number, number] | null>(null);
  const at = (r: number, c: number) => grid[r]?.[c] ?? 0;

  return (
    <Frame
      title={props.title}
      keys={[]}
      table={{ head: ["", ...columns], rows: rows.map((row, r) => [row, ...columns.map((_, c) => value(at(r, c), props.unit))]) }}
      summary={`heatmap ${text(props.title)}: ${rows.length} rows by ${columns.length} columns`}
    >
      {(width) => {
        const cellW = Math.max(8, (width - HEAT_GUTTER) / Math.max(1, columns.length));
        const showValues = cellW >= 34;
        const shown = labelIndices(columns.length, Math.max(2, Math.floor((width - HEAT_GUTTER) / 44)));
        return (
          <View style={{ gap: GAP.s }}>
            <View>
              <View style={{ marginLeft: HEAT_GUTTER, height: 16 }}>
                {shown.map((c) => (
                  <Text key={c} numberOfLines={1} style={{ position: "absolute", left: c * cellW - 4, width: Math.max(cellW + 8, 44), textAlign: "center", color: colors.foregroundMuted, fontSize: FONT.s - 1, writingDirection: "ltr" }}>
                    {columns[c]}
                  </Text>
                ))}
              </View>
              {rows.map((row, r) => (
                <View key={r} style={{ flexDirection: "row", height: HEAT_CELL_H, alignItems: "center" }}>
                  <Text numberOfLines={1} style={{ width: HEAT_GUTTER - 6, marginRight: 6, color: colors.foregroundMuted, fontSize: FONT.s - 1, ...bidi.text(row), textAlign: "right" }}>{row}</Text>
                  {columns.map((_, c) => {
                    const v = at(r, c);
                    const fill = shade(v);
                    const isActive = active?.[0] === r && active[1] === c;
                    return (
                      <Pressable
                        key={c}
                        accessibilityRole="button"
                        accessibilityLabel={`${row}, ${columns[c]}: ${value(v, props.unit)}`}
                        onHoverIn={() => setActive([r, c])}
                        onHoverOut={() => setActive((current) => (current?.[0] === r && current[1] === c ? null : current))}
                        onPress={() => setActive(isActive ? null : [r, c])}
                        style={{ width: cellW, height: HEAT_CELL_H, padding: 1 }}
                      >
                        <View style={{ flex: 1, borderRadius: 3, backgroundColor: fill, borderWidth: isActive ? 2 : 0, borderColor: colors.foreground, alignItems: "center", justifyContent: "center" }}>
                          {showValues ? <Text numberOfLines={1} style={{ color: readableOn(fill, "#ffffff", "#111111"), fontSize: FONT.s - 1, fontFamily: MONO, ...LTR_TEXT }}>{formatCompact(v)}</Text> : null}
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
              ))}
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: GAP.s, ...bidi.row(caption([rows[active?.[0] ?? 0] ?? ""])) }}>
              <Text style={{ color: colors.foregroundMuted, fontSize: FONT.s, fontFamily: MONO, ...LTR_TEXT }}>{value(low, props.unit)}</Text>
              <View style={{ flexDirection: "row", flex: 1, maxWidth: 140, height: 8, borderRadius: 4, overflow: "hidden", direction: "ltr" }}>
                {Array.from({ length: 12 }, (_, k) => (
                  <View key={k} style={{ flex: 1, backgroundColor: shade(low + ((k + 0.5) / 12) * (high - low)) }} />
                ))}
              </View>
              <Text style={{ color: colors.foregroundMuted, fontSize: FONT.s, fontFamily: MONO, ...LTR_TEXT }}>{value(high, props.unit)}</Text>
              <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: FONT.s, fontWeight: "600", ...bidi.text(active ? `${rows[active[0]]} ${columns[active[1]]}` : ""), textAlign: "right" }}>
                {active ? caption([`${rows[active[0]]} / ${columns[active[1]]}`, value(at(active[0], active[1]), props.unit)]) : ""}
              </Text>
            </View>
          </View>
        );
      }}
    </Frame>
  );
}

export function Treemap({ props }: NodeProps) {
  const { colors, pick } = useChartPalette();
  const bidi = useBidi();
  const tiles = list(props.tiles)
    .filter(isElement)
    .map((node, index) => ({
      label: text(node.props.label),
      amount: Math.max(0, Number(node.props.value) || 0),
      color: pick(node.props.tone, index),
    }));
  const total = tiles.reduce((sum, tile) => sum + tile.amount, 0);
  const [active, setActive] = useState<number | null>(null);
  const percent = (index: number) => `${total > 0 ? Math.round(((tiles[index]?.amount ?? 0) / total) * 100) : 0}%`;
  const current = active === null ? undefined : tiles[active];

  return (
    <Frame
      title={props.title}
      keys={[]}
      table={{ head: ["", "Value", "%"], rows: tiles.map((tile, index) => [tile.label, value(tile.amount, props.unit), percent(index)]) }}
      summary={`treemap ${text(props.title)}: ${tiles.map((tile) => tile.label).join(", ")}`}
    >
      {(width) => {
        const rects = treemap(tiles.map((tile) => tile.amount), width, TREEMAP_H);
        return (
          <View style={{ gap: GAP.s }}>
            <View style={{ width, height: TREEMAP_H }}>
              {tiles.map((tile, index) => {
                const rect = rects[index];
                if (!rect || rect.w < 2 || rect.h < 2) return null;
                const dim = active !== null && active !== index;
                return (
                  <Pressable
                    key={index}
                    accessibilityRole="button"
                    accessibilityLabel={`${tile.label}: ${value(tile.amount, props.unit)}`}
                    onHoverIn={() => setActive(index)}
                    onHoverOut={() => setActive((now) => (now === index ? null : now))}
                    onPress={() => setActive(active === index ? null : index)}
                    style={{ position: "absolute", left: rect.x, top: rect.y, width: rect.w, height: rect.h, padding: 1 }}
                  >
                    <View style={{ flex: 1, borderRadius: 4, padding: 5, backgroundColor: tile.color, opacity: dim ? 0.45 : 1, overflow: "hidden" }}>
                      {rect.w > 56 && rect.h > 34 ? (
                        <>
                          <Text numberOfLines={1} style={{ color: readableOn(tile.color, "#ffffff", "#111111"), fontSize: FONT.s, fontWeight: "600", ...bidi.text(tile.label) }}>{tile.label}</Text>
                          <Text numberOfLines={1} style={{ color: readableOn(tile.color, "#ffffff", "#111111"), fontSize: FONT.s - 1, fontFamily: MONO, ...LTR_TEXT }}>{value(tile.amount, props.unit)}</Text>
                        </>
                      ) : null}
                    </View>
                  </Pressable>
                );
              })}
            </View>
            <View style={{ minHeight: 18, flexDirection: "row", alignItems: "center", gap: GAP.s, ...bidi.row(current?.label ?? "") }}>
              {current ? <Key color={current.color} shape="box" /> : null}
              <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: FONT.s + 1, ...bidi.text(current?.label ?? "") }}>
                {current ? `${current.label} · ${value(current.amount, props.unit)} · ${percent(active as number)}` : `${value(total, props.unit)} total`}
              </Text>
            </View>
          </View>
        );
      }}
    </Frame>
  );
}

export function Gauge({ props }: NodeProps) {
  const { colors } = useUiEnv();
  const min = Number.isFinite(Number(props.min)) && props.min !== undefined ? Number(props.min) : 0;
  const max = Number.isFinite(Number(props.max)) && props.max !== undefined ? Number(props.max) : 100;
  const amount = Number(props.value) || 0;
  const fraction = Math.min(1, Math.max(0, (amount - min) / (max - min || 1)));
  const warnAt = props.warnAt === undefined ? undefined : Number(props.warnAt);
  const dangerAt = props.dangerAt === undefined ? undefined : Number(props.dangerAt);
  const tone = gaugeTone(amount, warnAt, dangerAt);
  const fill = tone === "default" ? colors.accent : toneColor(colors, tone as Tone);
  const reading = value(amount, props.unit);

  return (
    <GaugeDial fraction={fraction} fill={fill} track={colors.border} reading={reading} label={text(props.label)} min={value(min, props.unit)} max={value(max, props.unit)} />
  );
}

function GaugeDial({ fraction, fill, track, reading, label, min, max }: { fraction: number; fill: string; track: string; reading: string; label: string; min: string; max: string }) {
  const { colors } = useUiEnv();
  const bidi = useBidi();
  const [width, onLayout] = useWidth();
  const size = Math.min(width, 260);
  const outer = size / 2 - 4;
  const inner = outer - GAUGE_THICKNESS;
  const center = size / 2;
  const baseline = outer + 4;
  return (
    <View onLayout={onLayout} accessibilityRole="progressbar" accessibilityLabel={`gauge ${label}: ${reading}`} style={{ alignItems: "center", direction: "ltr" }}>
      {width === 0 ? null : (
        <View style={{ width: size, height: outer + 34 }}>
          {Array.from({ length: GAUGE_SLIVERS }, (_, k) => {
            const along = (k + 0.5) / GAUGE_SLIVERS;
            const angle = Math.PI + along * Math.PI;
            const s = segment(center + inner * Math.cos(angle), baseline + inner * Math.sin(angle), center + outer * Math.cos(angle), baseline + outer * Math.sin(angle), (Math.PI * outer * 1.7) / GAUGE_SLIVERS);
            return (
              <View
                key={k}
                pointerEvents="none"
                style={{ position: "absolute", left: s.left, top: s.top, width: s.width, height: s.height, backgroundColor: along <= fraction ? fill : track, transform: [{ rotate: `${s.rotate}rad` }] }}
              />
            );
          })}
          <View pointerEvents="none" style={{ position: "absolute", left: center - inner, width: inner * 2, top: outer - 26, alignItems: "center" }}>
            <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: FONT.h1, fontWeight: "700", fontFamily: MONO, ...LTR_TEXT }}>{reading}</Text>
            {label ? <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: FONT.s, ...bidi.text(label) }}>{label}</Text> : null}
          </View>
          <Text style={{ position: "absolute", left: center - outer, width: GAUGE_THICKNESS * 3, top: outer + 10, textAlign: "left", color: colors.foregroundMuted, fontSize: FONT.s - 1, fontFamily: MONO, writingDirection: "ltr" }}>{min}</Text>
          <Text style={{ position: "absolute", left: center + outer - GAUGE_THICKNESS * 3, width: GAUGE_THICKNESS * 3, top: outer + 10, textAlign: "right", color: colors.foregroundMuted, fontSize: FONT.s - 1, fontFamily: MONO, writingDirection: "ltr" }}>{max}</Text>
        </View>
      )}
    </View>
  );
}

export function Sparkline({ props }: NodeProps) {
  const { colors, pick } = useChartPalette();
  const bidi = useBidi();
  const values = numbers(props.values);
  const color = pick(props.tone, 0);
  const [width, onLayout] = useWidth();
  const low = Math.min(...values);
  const high = Math.max(...values);
  const last = values[values.length - 1] ?? 0;
  const label = text(props.label);
  return (
    <View accessibilityLabel={`trend ${label}: ${value(last, props.unit)}`} style={{ flexDirection: "row", alignItems: "center", gap: GAP.m, ...bidi.row(label) }}>
      {label ? <Text numberOfLines={1} style={{ width: 84, color: colors.foregroundMuted, fontSize: FONT.s + 1, ...bidi.text(label) }}>{label}</Text> : null}
      <View onLayout={onLayout} style={{ flex: 1, height: SPARK_H, minWidth: 60, direction: "ltr" }}>
        {width === 0 || values.length < 2
          ? null
          : (() => {
              const pad = 4;
              const x = (index: number) => pad + (index / (values.length - 1)) * (width - pad * 2);
              const y = (v: number) => pad + (1 - (v - low) / (high - low || 1)) * (SPARK_H - pad * 2);
              return (
                <>
                  {values.slice(1).map((v, index) => (
                    <Line key={index} x1={x(index)} y1={y(values[index] as number)} x2={x(index + 1)} y2={y(v)} color={color} thickness={2} />
                  ))}
                  <View pointerEvents="none" style={{ position: "absolute", left: x(values.length - 1) - 4, top: y(last) - 4, width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
                </>
              );
            })()}
      </View>
      <Text style={{ color: colors.foreground, fontSize: FONT.m, fontWeight: "700", fontFamily: MONO, ...LTR_TEXT }}>{value(last, props.unit)}</Text>
    </View>
  );
}

export function Timeline({ props }: NodeProps) {
  const { colors } = useUiEnv();
  const bidi = useBidi();
  const moments = list(props.moments).filter(isElement);
  const title = text(props.title);
  return (
    <View style={{ gap: GAP.s }}>
      {title ? <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: FONT.m, fontWeight: "600", ...bidi.text(title) }}>{title}</Text> : null}
      <View>
        {moments.map((node, index) => {
          const tone = node.props.tone as Tone | undefined;
          const color = tone && tone !== "default" ? toneColor(colors, tone) : colors.accent;
          const heading = text(node.props.title);
          const detail = text(node.props.detail);
          const last = index === moments.length - 1;
          return (
            <View key={index} style={{ flexDirection: "row", gap: GAP.m, ...bidi.row(heading) }}>
              <View style={{ width: 22, alignItems: "center" }}>
                <View style={{ width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: color, borderWidth: 3, borderColor: colors.surface1 }}>
                  {node.props.icon ? <AnimatedIcon name={String(node.props.icon)} size={11} color={readableOn(color, "#ffffff", "#111111")} /> : null}
                </View>
                {last ? null : <View style={{ flex: 1, width: 2, backgroundColor: colors.border }} />}
              </View>
              <View style={{ flex: 1, gap: 2, paddingBottom: last ? 0 : GAP.l }}>
                <Text style={{ color: colors.foregroundMuted, fontSize: FONT.s, ...bidi.text(text(node.props.time)) }}>{text(node.props.time)}</Text>
                <Text style={{ color: colors.foreground, fontSize: FONT.m, fontWeight: "600", ...bidi.text(heading) }}>{heading}</Text>
                {detail ? <Text style={{ color: colors.foregroundMuted, fontSize: FONT.s + 1, ...bidi.text(detail) }}>{detail}</Text> : null}
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

export function Gantt({ props }: NodeProps) {
  const { colors, pick } = useChartPalette();
  const bidi = useBidi();
  const tasks = list(props.tasks)
    .filter(isElement)
    .map((node, index) => {
      const start = parseTime(node.props.start);
      const end = parseTime(node.props.end);
      return {
        name: text(node.props.name),
        start,
        end: Number.isNaN(end) ? start : Math.max(start, end),
        color: pick(node.props.tone, index),
        progress: node.props.progress === undefined ? undefined : Math.min(100, Math.max(0, Number(node.props.progress) || 0)),
        asDate: Number.isNaN(Number(String(node.props.start).trim())),
      };
    })
    .filter((task) => !Number.isNaN(task.start));
  const asDate = tasks.some((task) => task.asDate);
  const low = Math.min(...tasks.map((task) => task.start));
  const high = Math.max(...tasks.map((task) => task.end), low + 1);
  const scale = niceScale(low, high);
  const [active, setActive] = useState<number | null>(null);
  const range = (task: (typeof tasks)[number]) => `${formatTime(task.start, asDate)} → ${formatTime(task.end, asDate)}`;
  const span = high - low || 1;

  return (
    <Frame
      title={props.title}
      keys={[]}
      table={{ head: ["", "Start", "End", "%"], rows: tasks.map((task) => [task.name, formatTime(task.start, asDate), formatTime(task.end, asDate), task.progress === undefined ? "" : `${task.progress}%`]) }}
      summary={`gantt ${text(props.title)}: ${tasks.map((task) => task.name).join(", ")}`}
    >
      {(width) => (
        <View style={{ gap: GAP.xs }}>
          <View style={{ height: 14, width }}>
            {[low, (low + high) / 2, high].map((tick, index) => (
              <Text key={index} numberOfLines={1} style={{ position: "absolute", top: 0, width: 80, left: index === 0 ? 0 : index === 1 ? width / 2 - 40 : width - 80, textAlign: index === 0 ? "left" : index === 1 ? "center" : "right", color: colors.foregroundMuted, fontSize: FONT.s - 1, fontFamily: MONO, writingDirection: "ltr" }}>
                {formatTime(tick, asDate)}
              </Text>
            ))}
          </View>
          {tasks.map((task, index) => {
            const left = ((task.start - low) / span) * width;
            const barW = Math.max(6, ((task.end - task.start) / span) * width);
            const isActive = active === index;
            return (
              <Pressable
                key={index}
                accessibilityRole="button"
                accessibilityLabel={`${task.name}: ${range(task)}`}
                onHoverIn={() => setActive(index)}
                onHoverOut={() => setActive((now) => (now === index ? null : now))}
                onPress={() => setActive(isActive ? null : index)}
                style={{ height: GANTT_ROW_H, justifyContent: "center", gap: 3, opacity: active === null || isActive ? 1 : 0.55 }}
              >
                <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: FONT.s, ...bidi.text(task.name) }}>
                  {isActive ? `${task.name} · ${range(task)}${task.progress === undefined ? "" : ` · ${task.progress}%`}` : task.name}
                </Text>
                <View style={{ height: 12, width, borderRadius: 3, backgroundColor: colors.surface2, direction: "ltr" }}>
                  <View style={{ position: "absolute", left, width: barW, height: 12, borderRadius: 3, backgroundColor: task.color, opacity: task.progress === undefined ? 1 : 0.4, overflow: "hidden" }} />
                  {task.progress === undefined ? null : (
                    <View style={{ position: "absolute", left, width: (barW * task.progress) / 100, height: 12, borderRadius: 3, backgroundColor: task.color }} />
                  )}
                </View>
              </Pressable>
            );
          })}
        </View>
      )}
    </Frame>
  );
}

export function Spinner({ props }: NodeProps) {
  const { colors } = useUiEnv();
  const bidi = useBidi();
  const label = text(props.label);
  const tone = props.tone as Tone | undefined;
  return (
    <View accessibilityRole="progressbar" accessibilityLabel={label || "Loading"} style={{ flexDirection: "row", alignItems: "center", gap: GAP.s, ...bidi.row(label) }}>
      <AnimatedIcon name={props.icon ? String(props.icon) : "Loader"} size={18} color={tone && tone !== "default" ? toneColor(colors, tone) : colors.accent} animation="spin" />
      {label ? <Text style={{ color: colors.foregroundMuted, fontSize: FONT.m, ...bidi.text(label) }}>{label}</Text> : null}
    </View>
  );
}
