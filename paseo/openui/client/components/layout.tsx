import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useBidi } from "../bidi";
import { isElement } from "../runtime";
import { AnimatedIcon } from "./animated-icon";
import { FONT, GAP, RADIUS, toneColor, useUiEnv, wash } from "../tokens";
import type { NodeProps } from "./types";

function asList(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export function Stack({ props, renderNode }: NodeProps) {
  const row = props.direction === "row";
  const align = { start: "flex-start", center: "center", end: "flex-end", stretch: "stretch" } as const;
  return (
    <View
      style={{
        flexDirection: row ? "row" : "column",
        gap: GAP[(props.gap as keyof typeof GAP) ?? "s"],
        alignItems: align[(props.align as keyof typeof align) ?? "stretch"],
        flexWrap: props.wrap ? "wrap" : "nowrap",
      }}
    >
      {renderNode(props.children)}
    </View>
  );
}

export function Grid({ props, renderNode }: NodeProps) {
  const { compact } = useUiEnv();
  const wanted = Math.max(1, Math.round(props.columns ?? 2));
  const columns = compact ? Math.min(wanted, 2) : wanted;
  const items = asList(props.children);
  const rows: unknown[][] = [];
  for (let index = 0; index < items.length; index += columns) rows.push(items.slice(index, index + columns));
  return (
    <View style={{ gap: GAP.s }}>
      {rows.map((row, rowIndex) => (
        <View key={rowIndex} style={{ flexDirection: "row", gap: GAP.s }}>
          {Array.from({ length: columns }, (_, column) => (
            <View key={column} style={{ flex: 1, minWidth: 0 }}>
              {row[column] === undefined ? null : renderNode(row[column])}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

export function Card({ props, renderNode }: NodeProps) {
  const { colors, compact } = useUiEnv();
  const bidi = useBidi();
  const tone = props.tone && props.tone !== "default" ? toneColor(colors, props.tone) : undefined;
  return (
    <View
      style={{
        gap: GAP.s,
        padding: compact ? GAP.m : GAP.l,
        borderRadius: RADIUS.m,
        borderWidth: 1,
        borderColor: tone ?? colors.border,
        backgroundColor: tone ? wash(tone, colors.surface1, 0.1) : colors.surface1,
      }}
    >
      {props.title || props.subtitle ? (
        <View style={{ gap: 2 }}>
          {props.title ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: GAP.s, ...bidi.row(String(props.title)) }}>
              {props.icon ? <AnimatedIcon name={String(props.icon)} size={18} color={tone ?? colors.accent} /> : null}
              <Text accessibilityRole="header" style={{ flex: 1, color: colors.foreground, fontSize: FONT.l, fontWeight: "600", ...bidi.text(String(props.title)) }}>
                {props.title}
              </Text>
            </View>
          ) : null}
          {props.subtitle ? (
            <Text style={{ color: colors.foregroundMuted, fontSize: FONT.m }}>{props.subtitle}</Text>
          ) : null}
        </View>
      ) : null}
      {renderNode(props.children)}
    </View>
  );
}

export function Tabs({ props, renderNode }: NodeProps) {
  const { colors } = useUiEnv();
  const [selected, setSelected] = useState(0);
  const tabs = asList(props.items).filter(isElement);
  if (tabs.length === 0) return null;
  const active = tabs[Math.min(selected, tabs.length - 1)];
  return (
    <View style={{ gap: GAP.m }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View
          accessibilityRole="tablist"
          style={{ flexDirection: "row", gap: GAP.xs, borderBottomWidth: 1, borderBottomColor: colors.border }}
        >
          {tabs.map((tab, index) => {
            const isActive = tab === active;
            return (
              <Pressable
                key={index}
                accessibilityRole="tab"
                accessibilityState={{ selected: isActive }}
                onPress={() => setSelected(index)}
                style={{
                  paddingVertical: GAP.s,
                  paddingHorizontal: GAP.m,
                  borderBottomWidth: 2,
                  borderBottomColor: isActive ? colors.accent : "transparent",
                }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: GAP.xs }}>
                  {tab.props.icon ? <AnimatedIcon name={String(tab.props.icon)} size={14} color={isActive ? colors.accent : colors.foregroundMuted} /> : null}
                  <Text
                    style={{
                      color: isActive ? colors.foreground : colors.foregroundMuted,
                      fontSize: FONT.m,
                      fontWeight: isActive ? "600" : "400",
                    }}
                  >
                    {String(tab.props.label ?? "")}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
      {active ? <View style={{ gap: GAP.s }}>{renderNode(active.props.children)}</View> : null}
    </View>
  );
}

function PanelItem({ title, icon, open, children }: { title: string; icon?: string; open: boolean; children: React.ReactNode }) {
  const { colors } = useUiEnv();
  const [expanded, setExpanded] = useState(open);
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: colors.border }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={{ flexDirection: "row", alignItems: "center", gap: GAP.s, paddingVertical: GAP.m }}
      >
        <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={16} color={colors.foregroundMuted} />
        {icon ? <AnimatedIcon name={icon} size={16} color={colors.accent} /> : null}
        <Text style={{ flex: 1, color: colors.foreground, fontSize: FONT.m, fontWeight: "600" }}>{title}</Text>
      </Pressable>
      {expanded ? <View style={{ gap: GAP.s, paddingBottom: GAP.m }}>{children}</View> : null}
    </View>
  );
}

export function Accordion({ props, renderNode }: NodeProps) {
  const { colors } = useUiEnv();
  const panels = asList(props.items).filter(isElement);
  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: colors.border }}>
      {panels.map((panel, index) => (
        <PanelItem key={index} title={String(panel.props.title ?? "")} icon={panel.props.icon ? String(panel.props.icon) : undefined} open={panel.props.open === true}>
          {renderNode(panel.props.children)}
        </PanelItem>
      ))}
    </View>
  );
}

export function Separator() {
  const { colors } = useUiEnv();
  return <View style={{ height: 1, backgroundColor: colors.border }} />;
}
