import { Icon } from "@getpaseo/plugin/client/react-native";
import { ScrollView, Text, View } from "react-native";
import { isElement } from "../runtime";
import { LTR_TEXT, useBidi } from "../bidi";
import { FONT, GAP, MONO, RADIUS, toneColor, type Tone, useUiEnv } from "../tokens";
import { AnimatedIcon } from "./animated-icon";
import type { NodeProps } from "./types";

function items(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function cell(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

export function Table({ props }: NodeProps) {
  const { colors } = useUiEnv();
  const bidi = useBidi();
  const headers = items(props.headers).map(cell);
  const rows = items(props.rows).map((row) => items(row));
  const scroll = headers.length > 3;
  const width = scroll ? 132 : undefined;
  const table = (
    <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: RADIUS.s, overflow: "hidden", ...bidi.row(headers.join(" ")) }}>
      <View style={{ flexDirection: "row", backgroundColor: colors.surface1 }}>
        {headers.map((header, index) => (
          <Text
            key={index}
            style={{ width, flex: scroll ? undefined : 1, padding: GAP.s, color: colors.foreground, fontSize: FONT.s + 1, fontWeight: "600", ...bidi.text(header) }}
          >
            {header}
          </Text>
        ))}
      </View>
      {rows.map((row, rowIndex) => (
        <View key={rowIndex} style={{ flexDirection: "row", borderTopWidth: 1, borderTopColor: colors.border }}>
          {headers.map((_, index) => (
            <Text
              key={index}
              selectable
              style={{ width, flex: scroll ? undefined : 1, padding: GAP.s, color: colors.foreground, fontSize: FONT.m, ...bidi.text(cell(row[index])) }}
            >
              {cell(row[index])}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
  return (
    <View style={{ gap: GAP.xs }}>
      {scroll ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {table}
        </ScrollView>
      ) : (
        table
      )}
      {props.caption ? <Text style={{ color: colors.foregroundMuted, fontSize: FONT.s, ...bidi.text(String(props.caption)) }}>{props.caption}</Text> : null}
    </View>
  );
}

export function KeyValue({ props }: NodeProps) {
  const { colors, compact } = useUiEnv();
  const bidi = useBidi();
  const pairs = items(props.items).filter(isElement);
  return (
    <View style={{ gap: GAP.s }}>
      {pairs.map((pair, index) => (
        <View key={index} style={{ flexDirection: compact ? "column" : "row", gap: compact ? 2 : GAP.m, ...bidi.row(cell(pair.props.key)) }}>
          <Text style={{ width: compact ? undefined : 140, color: colors.foregroundMuted, fontSize: FONT.m, ...bidi.text(cell(pair.props.key)) }}>{cell(pair.props.key)}</Text>
          <Text selectable style={{ flex: 1, color: colors.foreground, fontSize: FONT.m, ...bidi.text(cell(pair.props.value)) }}>{cell(pair.props.value)}</Text>
        </View>
      ))}
    </View>
  );
}

export function List({ props }: NodeProps) {
  const { colors } = useUiEnv();
  const bidi = useBidi();
  return (
    <View style={{ gap: GAP.xs }}>
      {items(props.items).map((item, index) => (
        <View key={index} style={{ flexDirection: "row", gap: GAP.s, ...bidi.row(cell(item)) }}>
          <Text style={{ minWidth: 16, color: colors.foregroundMuted, fontSize: FONT.m, ...LTR_TEXT }}>{props.ordered ? `${index + 1}.` : "•"}</Text>
          <Text selectable style={{ flex: 1, color: colors.foreground, fontSize: FONT.m, lineHeight: 20, ...bidi.text(cell(item)) }}>{cell(item)}</Text>
        </View>
      ))}
    </View>
  );
}

export function Steps({ props }: NodeProps) {
  const { colors } = useUiEnv();
  const bidi = useBidi();
  const steps = items(props.items).filter(isElement);
  return (
    <View>
      {steps.map((step, index) => {
        const status = (step.props.status as string | undefined) ?? "todo";
        const tone = { done: colors.statusSuccess, current: colors.accent, running: colors.accent, failed: colors.statusDanger, todo: colors.foregroundMuted }[
          status as "todo"
        ] ?? colors.foregroundMuted;
        const icon = step.props.icon ? String(step.props.icon) : ({ done: "CircleCheck", current: "CircleDot", running: "Loader", failed: "CircleX", todo: "Circle" }[status as "todo"] ?? "Circle");
        const last = index === steps.length - 1;
        return (
          <View key={index} style={{ flexDirection: "row", gap: GAP.m, ...bidi.row(`${cell(step.props.title)} ${cell(step.props.description)}`) }}>
            <View style={{ alignItems: "center" }}>
              <AnimatedIcon name={icon} size={18} color={tone} animation={status === "running" ? "spin" : undefined} />
              {last ? null : <View style={{ flex: 1, width: 1, backgroundColor: colors.border, marginVertical: 2 }} />}
            </View>
            <View style={{ flex: 1, gap: 2, paddingBottom: last ? 0 : GAP.m }}>
              <Text style={{ color: status === "todo" ? colors.foregroundMuted : colors.foreground, fontSize: FONT.m, fontWeight: "600", ...bidi.text(cell(step.props.title)) }}>
                {cell(step.props.title)}
              </Text>
              {step.props.description ? (
                <Text selectable style={{ color: colors.foregroundMuted, fontSize: FONT.m, lineHeight: 20, ...bidi.text(cell(step.props.description)) }}>
                  {cell(step.props.description)}
                </Text>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

export function Metric({ props }: NodeProps) {
  const { colors, compact } = useUiEnv();
  const bidi = useBidi();
  return (
    <View
      style={{
        gap: 2,
        padding: compact ? GAP.m : GAP.l,
        borderRadius: RADIUS.m,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: GAP.xs, ...bidi.row(cell(props.label)) }}>
        {props.icon ? <AnimatedIcon name={String(props.icon)} size={FONT.m} color={colors.foregroundMuted} /> : null}
        <Text style={{ flexShrink: 1, color: colors.foregroundMuted, fontSize: FONT.s, ...bidi.text(cell(props.label)) }}>{cell(props.label)}</Text>
      </View>
      <Text selectable style={{ color: toneColor(colors, props.tone as Tone | undefined), fontSize: compact ? FONT.h2 : FONT.h1, fontWeight: "700", ...bidi.text(cell(props.value)) }}>
        {cell(props.value)}
      </Text>
      {props.hint ? <Text style={{ color: colors.foregroundMuted, fontSize: FONT.s, ...bidi.text(String(props.hint)) }}>{props.hint}</Text> : null}
    </View>
  );
}

function Bar({ ratio, color }: { ratio: number; color: string }) {
  const { colors } = useUiEnv();
  return (
    <View style={{ height: 8, borderRadius: 4, backgroundColor: colors.surface2, overflow: "hidden" }}>
      <View style={{ width: `${Math.min(Math.max(ratio, 0), 1) * 100}%`, height: 8, backgroundColor: color }} />
    </View>
  );
}

export function Progress({ props }: NodeProps) {
  const { colors } = useUiEnv();
  const bidi = useBidi();
  const max = props.max && props.max > 0 ? props.max : 100;
  const ratio = (props.value ?? 0) / max;
  return (
    <View style={{ gap: GAP.xs }} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max, now: props.value ?? 0 }}>
      {props.label ? (
        <View style={{ flexDirection: "row", justifyContent: "space-between", ...bidi.row(String(props.label)) }}>
          <Text style={{ color: colors.foreground, fontSize: FONT.m, ...bidi.text(String(props.label)) }}>{props.label}</Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: FONT.m, ...LTR_TEXT }}>{`${Math.round(ratio * 100)}%`}</Text>
        </View>
      ) : null}
      <Bar ratio={ratio} color={props.tone ? toneColor(colors, props.tone as Tone) : colors.accent} />
    </View>
  );
}

export function BarChart({ props }: NodeProps) {
  const { colors } = useUiEnv();
  const bidi = useBidi();
  const labels = items(props.labels).map(cell);
  const values = items(props.values).map((value) => Number(value) || 0);
  const peak = Math.max(...values, 0) || 1;
  return (
    <View style={{ gap: GAP.s }}>
      {props.title ? <Text style={{ color: colors.foreground, fontSize: FONT.m, fontWeight: "600", ...bidi.text(String(props.title)) }}>{props.title}</Text> : null}
      {labels.map((label, index) => (
        <View key={index} style={{ gap: 2 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", gap: GAP.s, ...bidi.row(label) }}>
            <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: FONT.s + 1, ...bidi.text(label) }}>{label}</Text>
            <Text style={{ color: colors.foregroundMuted, fontSize: FONT.s + 1, fontFamily: MONO, ...LTR_TEXT }}>
              {values[index] ?? 0}
              {props.unit ?? ""}
            </Text>
          </View>
          <Bar ratio={(values[index] ?? 0) / peak} color={colors.accent} />
        </View>
      ))}
    </View>
  );
}

export function StackedBar({ props }: NodeProps) {
  const { colors } = useUiEnv();
  const bidi = useBidi();
  const palette = [colors.accent, colors.statusSuccess, colors.statusWarning, colors.statusDanger, colors.foregroundMuted];
  const slices = items(props.slices).filter(isElement);
  const total = slices.reduce((sum, slice) => sum + (Number(slice.props.value) || 0), 0) || 1;
  const colorOf = (slice: (typeof slices)[number], index: number) =>
    slice.props.tone ? toneColor(colors, slice.props.tone as Tone) : (palette[index % palette.length] ?? colors.accent);
  return (
    <View style={{ gap: GAP.s }}>
      {props.title ? <Text style={{ color: colors.foreground, fontSize: FONT.m, fontWeight: "600", ...bidi.text(String(props.title)) }}>{props.title}</Text> : null}
      <View style={{ flexDirection: "row", height: 10, borderRadius: 5, overflow: "hidden", backgroundColor: colors.surface2 }}>
        {slices.map((slice, index) => (
          <View key={index} style={{ flex: Number(slice.props.value) || 0, backgroundColor: colorOf(slice, index) }} />
        ))}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: GAP.m }}>
        {slices.map((slice, index) => (
          <View key={index} style={{ flexDirection: "row", alignItems: "center", gap: 6, ...bidi.row(cell(slice.props.label)) }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colorOf(slice, index) }} />
            <Text style={{ color: colors.foreground, fontSize: FONT.s + 1, ...bidi.text(cell(slice.props.label)) }}>
              {cell(slice.props.label)} {Math.round(((Number(slice.props.value) || 0) / total) * 100)}%
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

interface TreeNode {
  name: string;
  children: Map<string, TreeNode>;
  file: boolean;
}

function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: "", children: new Map(), file: false };
  for (const path of paths) {
    const parts = path.split("/").filter(Boolean);
    let node = root;
    parts.forEach((part, index) => {
      const next = node.children.get(part) ?? { name: part, children: new Map(), file: index === parts.length - 1 };
      node.children.set(part, next);
      node = next;
    });
  }
  return root;
}

function flatten(node: TreeNode, depth: number, out: Array<{ name: string; depth: number; file: boolean }>) {
  const sorted = [...node.children.values()].sort((a, b) => Number(a.file) - Number(b.file) || a.name.localeCompare(b.name));
  for (const child of sorted) {
    out.push({ name: child.name, depth, file: child.file });
    flatten(child, depth + 1, out);
  }
  return out;
}

export function FileTree({ props }: NodeProps) {
  const { colors } = useUiEnv();
  const bidi = useBidi();
  const rows = flatten(buildTree(items(props.paths).map(cell)), 0, []);
  return (
    <View style={{ gap: 2, alignItems: "flex-start", direction: "ltr" }}>
      {props.title ? <Text style={{ color: colors.foreground, fontSize: FONT.m, fontWeight: "600", marginBottom: GAP.xs, ...bidi.text(String(props.title)) }}>{props.title}</Text> : null}
      {rows.map((row, index) => (
        <View key={index} style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingStart: row.depth * 16 }}>
          <Icon name={row.file ? "FileText" : "Folder"} size={14} color={row.file ? colors.foregroundMuted : colors.accent} />
          <Text style={{ color: colors.foreground, fontSize: FONT.m, fontFamily: MONO, ...LTR_TEXT }}>{row.name}</Text>
        </View>
      ))}
    </View>
  );
}
