import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  addMonths,
  asRange,
  covers,
  monthGrid,
  monthLabel,
  pickDay,
  startMonth,
  weekdayLabels,
} from "../../shared/calendar";
import { matchOptions, toggleOption } from "../../shared/table";
import { useBidi } from "../bidi";
import { useField } from "../runtime";
import { FONT, GAP, RADIUS, useUiEnv, wash } from "../tokens";
import { Field, OptionRow } from "./input";
import type { NodeProps } from "./types";

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

export function ToggleGroup({ props }: NodeProps) {
  const { colors, disabled } = useUiEnv();
  const bidi = useBidi();
  const field = useField<string | undefined>(String(props.name), props.value, "ToggleGroup", undefined);
  const options = strings(props.options);
  const icons = strings(props.icons);
  return (
    <Field label={props.label}>
      <View
        accessibilityRole="radiogroup"
        style={{
          flexDirection: "row",
          alignSelf: "flex-start",
          maxWidth: "100%",
          flexWrap: "wrap",
          padding: 3,
          gap: 2,
          borderRadius: RADIUS.s + 3,
          backgroundColor: colors.surface2,
        }}
      >
        {options.map((option, index) => {
          const selected = field.value === option;
          const icon = icons[index];
          return (
            <Pressable
              key={option}
              accessibilityRole="radio"
              accessibilityState={{ selected, disabled }}
              disabled={disabled}
              onPress={() => field.setValue(option)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: GAP.xs + 2,
                minHeight: 34,
                paddingHorizontal: GAP.m,
                borderRadius: RADIUS.s,
                backgroundColor: selected ? colors.surface0 : "transparent",
                opacity: disabled ? 0.5 : 1,
              }}
            >
              {icon ? <Icon name={icon} size={15} color={selected ? colors.foreground : colors.foregroundMuted} /> : null}
              <Text
                style={{
                  color: selected ? colors.foreground : colors.foregroundMuted,
                  fontSize: FONT.m,
                  fontWeight: selected ? "600" : "400",
                  ...bidi.text(option),
                }}
              >
                {option}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </Field>
  );
}

function Trigger({
  text,
  placeholder,
  icon,
  open,
  onPress,
}: {
  text: string;
  placeholder: string;
  icon: string;
  open: boolean;
  onPress: () => void;
}) {
  const { colors, disabled } = useUiEnv();
  const bidi = useBidi();
  return (
    <Pressable
      accessibilityRole="combobox"
      accessibilityState={{ expanded: open, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{
        minHeight: 40,
        flexDirection: "row",
        alignItems: "center",
        gap: GAP.s,
        paddingHorizontal: GAP.m,
        borderWidth: 1,
        borderColor: open ? colors.accent : colors.border,
        borderRadius: RADIUS.s,
        backgroundColor: colors.surface0,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Icon name={icon} size={16} color={colors.foregroundMuted} />
      <Text
        numberOfLines={1}
        style={{ flex: 1, color: text ? colors.foreground : colors.foregroundMuted, fontSize: FONT.m, ...bidi.text(text || placeholder) }}
      >
        {text || placeholder}
      </Text>
      <Icon name={open ? "ChevronUp" : "ChevronDown"} size={16} color={colors.foregroundMuted} />
    </Pressable>
  );
}

export function Panel({ children }: { children: ReactNode }) {
  const { colors } = useUiEnv();
  return (
    <View
      style={{
        marginTop: GAP.xs,
        padding: GAP.s,
        gap: GAP.s,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: RADIUS.s,
        backgroundColor: colors.surface1,
      }}
    >
      {children}
    </View>
  );
}

interface ChoiceProps {
  props: NodeProps["props"];
  multiple: boolean;
}

function Choice({ props, multiple }: ChoiceProps) {
  const { colors, disabled } = useUiEnv();
  const bidi = useBidi();
  const field = useField<string | string[] | undefined>(
    String(props.name),
    props.value,
    multiple ? "MultiSelect" : "Combobox",
    multiple ? [] : undefined,
  );
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const options = strings(props.options);
  const chosen = multiple ? strings(field.value) : [];
  const single = multiple ? undefined : (field.value as string | undefined);
  const shown = matchOptions(options, query);
  const summary = multiple
    ? chosen.length > 3
      ? `${chosen.length} selected`
      : chosen.join(", ")
    : (single ?? "");
  const placeholder = String(props.placeholder ?? (multiple ? "Select…" : "Select one…"));
  return (
    <Field label={props.label}>
      <View>
        <Trigger text={summary} placeholder={placeholder} icon={multiple ? "ListChecks" : "ChevronsUpDown"} open={open} onPress={() => setOpen(!open)} />
        {open ? (
          <Panel>
            <TextInput
              value={query}
              onChangeText={setQuery}
              editable={!disabled}
              placeholder="Search…"
              placeholderTextColor={colors.foregroundMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={{
                minHeight: 38,
                paddingHorizontal: GAP.m,
                color: colors.foreground,
                fontSize: FONT.m,
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: RADIUS.s,
                backgroundColor: colors.surface0,
                ...bidi.text(query || "Search"),
              }}
            />
            <ScrollView nestedScrollEnabled style={{ maxHeight: 220 }} keyboardShouldPersistTaps="handled">
              {shown.length === 0 ? (
                <Text style={{ padding: GAP.s, color: colors.foregroundMuted, fontSize: FONT.m }}>No matches</Text>
              ) : (
                shown.map((option) => (
                  <OptionRow
                    key={option}
                    label={option}
                    multiple={multiple}
                    disabled={disabled}
                    selected={multiple ? chosen.includes(option) : single === option}
                    onPress={() => {
                      if (multiple) {
                        field.setValue(toggleOption(chosen, option));
                        return;
                      }
                      field.setValue(option);
                      setOpen(false);
                      setQuery("");
                    }}
                  />
                ))
              )}
            </ScrollView>
            {multiple && chosen.length > 0 ? (
              <Pressable accessibilityRole="button" onPress={() => field.setValue([])} style={{ alignSelf: "flex-start", padding: GAP.xs }}>
                <Text style={{ color: colors.accent, fontSize: FONT.m }}>{`Clear (${chosen.length})`}</Text>
              </Pressable>
            ) : null}
          </Panel>
        ) : null}
      </View>
    </Field>
  );
}

export function Combobox({ props }: NodeProps) {
  return <Choice props={props} multiple={false} />;
}

export function MultiSelect({ props }: NodeProps) {
  return <Choice props={props} multiple />;
}

function today(): { year: number; month: number } {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

export function DatePicker({ props }: NodeProps) {
  const { colors, disabled } = useUiEnv();
  const range = props.range === true;
  const field = useField<string | string[] | undefined>(String(props.name), props.value, "DatePicker", undefined);
  const held = asRange(field.value);
  const [open, setOpen] = useState(false);
  const min = typeof props.min === "string" ? props.min : undefined;
  const max = typeof props.max === "string" ? props.max : undefined;
  const [view, setView] = useState(() => startMonth(field.value, min, max, today()));
  const text = held.length === 0 ? "" : range && held.length === 2 ? `${held[0]} → ${held[1]}` : range ? `${held[0]} → …` : (held[0] ?? "");
  const shift = (delta: number) => setView(addMonths(view.year, view.month, delta));
  const arrow = (icon: string, delta: number, label: string) => (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={() => shift(delta)} style={{ padding: GAP.s }}>
      <Icon name={icon} size={18} color={colors.foreground} />
    </Pressable>
  );
  return (
    <Field label={props.label}>
      <View>
        <Trigger text={text} placeholder={range ? "Pick a date range" : "Pick a date"} icon="Calendar" open={open} onPress={() => setOpen(!open)} />
        {open ? (
          <Panel>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              {arrow("ChevronLeft", -1, "Previous month")}
              <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: FONT.l, fontWeight: "600" }}>
                {monthLabel(view.year, view.month)}
              </Text>
              {arrow("ChevronRight", 1, "Next month")}
            </View>
            <View style={{ flexDirection: "row" }}>
              {weekdayLabels().map((label) => (
                <Text key={label} style={{ width: `${100 / 7}%`, textAlign: "center", color: colors.foregroundMuted, fontSize: FONT.s }}>
                  {label}
                </Text>
              ))}
            </View>
            {monthGrid(view.year, view.month).map((week, weekIndex) => (
              <View key={weekIndex} style={{ flexDirection: "row" }}>
                {week.map((day, index) => {
                  if (!day) return <View key={index} style={{ width: `${100 / 7}%`, height: 38 }} />;
                  const inside = covers(field.value, day);
                  const edge = day === held[0] || day === held[held.length - 1];
                  const blocked = disabled || (min !== undefined && day < min) || (max !== undefined && day > max);
                  return (
                    <Pressable
                      key={index}
                      accessibilityRole="button"
                      accessibilityLabel={day}
                      accessibilityState={{ selected: inside, disabled: blocked }}
                      disabled={blocked}
                      onPress={() => {
                        const next = pickDay(field.value, day, range);
                        field.setValue(next);
                        if (!range || (Array.isArray(next) && next.length === 2)) setOpen(false);
                      }}
                      style={{
                        width: `${100 / 7}%`,
                        height: 38,
                        alignItems: "center",
                        justifyContent: "center",
                        borderRadius: edge ? RADIUS.s : 0,
                        backgroundColor: edge ? colors.accent : inside ? wash(colors.accent, colors.surface2, 0.2) : "transparent",
                        opacity: blocked ? 0.3 : 1,
                      }}
                    >
                      <Text style={{ color: edge ? colors.accentForeground : colors.foreground, fontSize: FONT.m }}>{Number(day.slice(8))}</Text>
                    </Pressable>
                  );
                })}
              </View>
            ))}
            {held.length > 0 ? (
              <Pressable accessibilityRole="button" onPress={() => field.setValue(range ? [] : "")} style={{ alignSelf: "flex-start", padding: GAP.xs }}>
                <Text style={{ color: colors.accent, fontSize: FONT.m }}>Clear</Text>
              </Pressable>
            ) : null}
          </Panel>
        ) : null}
      </View>
    </Field>
  );
}
