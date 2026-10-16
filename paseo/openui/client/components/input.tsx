import { TextInput } from "@getpaseo/plugin/client/react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useContext } from "react";
import { Pressable, Switch as RNSwitch, Text, View } from "react-native";
import { useBidi } from "../bidi";
import { FormNameContext, useField, useTriggerAction } from "../runtime";
import { FONT, GAP, RADIUS, useUiEnv } from "../tokens";
import { AnimatedIcon } from "./animated-icon";
import type { NodeProps } from "./types";

function Field({ label, children }: { label?: string; children: ReactNode }) {
  const { colors } = useUiEnv();
  const bidi = useBidi();
  return (
    <View style={{ gap: GAP.xs }}>
      {label ? <Text style={{ color: colors.foreground, fontSize: FONT.m, fontWeight: "600", ...bidi.text(label) }}>{label}</Text> : null}
      {children}
    </View>
  );
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

export function Button({ props }: NodeProps) {
  const { colors, disabled } = useUiEnv();
  const bidi = useBidi();
  const trigger = useTriggerAction();
  const formName = useContext(FormNameContext);
  const variant = (props.variant as string | undefined) ?? "secondary";
  const palette = {
    primary: { background: colors.accent, text: colors.accentForeground, border: colors.accent },
    danger: { background: "transparent", text: colors.statusDanger, border: colors.statusDanger },
    secondary: { background: colors.surface2, text: colors.foreground, border: colors.border },
  }[variant as "primary"] ?? { background: colors.surface2, text: colors.foreground, border: colors.border };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={() => trigger(String(props.label), formName, props.action)}
      style={({ pressed }) => ({
        alignSelf: "flex-start",
        minHeight: 40,
        justifyContent: "center",
        paddingHorizontal: GAP.l,
        borderRadius: RADIUS.s,
        borderWidth: 1,
        borderColor: palette.border,
        backgroundColor: palette.background,
        opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: GAP.s, ...bidi.row(String(props.label)) }}>
        {props.icon ? <AnimatedIcon name={String(props.icon)} size={16} color={palette.text} /> : null}
        <Text style={{ color: palette.text, fontSize: FONT.m, fontWeight: "600", ...bidi.text(String(props.label)), textAlign: "center" }}>{props.label}</Text>
      </View>
    </Pressable>
  );
}

export function Form({ props, renderNode }: NodeProps) {
  return (
    <FormNameContext.Provider value={String(props.name)}>
      <View style={{ gap: GAP.m }}>
        {renderNode(props.fields)}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: GAP.s }}>{renderNode(props.buttons)}</View>
      </View>
    </FormNameContext.Provider>
  );
}

function TextField({ props, multiline }: { props: NodeProps["props"]; multiline: boolean }) {
  const { colors, disabled } = useUiEnv();
  const bidi = useBidi();
  const field = useField<string>(String(props.name), props.value, multiline ? "TextArea" : "Input", "");
  const kind = (props.kind as string | undefined) ?? "text";
  return (
    <Field label={props.label}>
      <TextInput
        value={String(field.value ?? "")}
        onChangeText={field.setValue}
        editable={!disabled}
        multiline={multiline}
        placeholder={props.placeholder}
        placeholderTextColor={colors.foregroundMuted}
        secureTextEntry={kind === "password"}
        keyboardType={kind === "number" ? "numeric" : kind === "email" ? "email-address" : kind === "url" ? "url" : "default"}
        autoCapitalize={kind === "text" ? "sentences" : "none"}
        style={{
          minHeight: multiline ? 88 : 40,
          paddingHorizontal: GAP.m,
          paddingVertical: GAP.s,
          textAlignVertical: multiline ? "top" : "center",
          color: colors.foreground,
          fontSize: FONT.m,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: RADIUS.s,
          backgroundColor: colors.surface0,
          opacity: disabled ? 0.5 : 1,
          // What is typed decides the direction; the placeholder decides while the field is empty.
          ...bidi.text(String(field.value || props.placeholder || props.label || "")),
        }}
      />
    </Field>
  );
}

export function Input({ props }: NodeProps) {
  return <TextField props={props} multiline={false} />;
}

export function TextArea({ props }: NodeProps) {
  return <TextField props={props} multiline />;
}

export function Select({ props }: NodeProps) {
  const { colors, disabled } = useUiEnv();
  const bidi = useBidi();
  const field = useField<string | undefined>(String(props.name), props.value, "Select", undefined);
  return (
    <Field label={props.label}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: GAP.s }}>
        {strings(props.options).map((option) => {
          const selected = field.value === option;
          return (
            <Pressable
              key={option}
              accessibilityRole="radio"
              accessibilityState={{ selected, disabled }}
              disabled={disabled}
              onPress={() => field.setValue(option)}
              style={{
                paddingHorizontal: GAP.m,
                paddingVertical: GAP.s,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: selected ? colors.accent : colors.border,
                backgroundColor: selected ? colors.accent : colors.surface1,
                opacity: disabled ? 0.5 : 1,
              }}
            >
              <Text style={{ color: selected ? colors.accentForeground : colors.foreground, fontSize: FONT.m, ...bidi.text(option) }}>{option}</Text>
            </Pressable>
          );
        })}
      </View>
    </Field>
  );
}

function OptionRow({
  label,
  selected,
  multiple,
  disabled,
  onPress,
}: {
  label: string;
  selected: boolean;
  multiple: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const { colors } = useUiEnv();
  const bidi = useBidi();
  return (
    <Pressable
      accessibilityRole={multiple ? "checkbox" : "radio"}
      accessibilityState={{ selected, checked: selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{ flexDirection: "row", alignItems: "center", gap: GAP.m, minHeight: 36, opacity: disabled ? 0.5 : 1, ...bidi.row(label) }}
    >
      <View
        style={{
          width: 20,
          height: 20,
          borderRadius: multiple ? 5 : 10,
          borderWidth: 2,
          borderColor: selected ? colors.accent : colors.border,
          backgroundColor: selected && multiple ? colors.accent : "transparent",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {selected && multiple ? <Icon name="Check" size={13} color={colors.accentForeground} /> : null}
        {selected && !multiple ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent }} /> : null}
      </View>
      <Text style={{ flex: 1, color: colors.foreground, fontSize: FONT.m, ...bidi.text(label) }}>{label}</Text>
    </Pressable>
  );
}

export function RadioGroup({ props }: NodeProps) {
  const { disabled } = useUiEnv();
  const field = useField<string | undefined>(String(props.name), props.value, "RadioGroup", undefined);
  return (
    <Field label={props.label}>
      {strings(props.options).map((option) => (
        <OptionRow
          key={option}
          label={option}
          selected={field.value === option}
          multiple={false}
          disabled={disabled}
          onPress={() => field.setValue(option)}
        />
      ))}
    </Field>
  );
}

export function CheckboxGroup({ props }: NodeProps) {
  const { disabled } = useUiEnv();
  const field = useField<string[]>(String(props.name), props.value, "CheckboxGroup", []);
  const chosen = Array.isArray(field.value) ? field.value : [];
  return (
    <Field label={props.label}>
      {strings(props.options).map((option) => (
        <OptionRow
          key={option}
          label={option}
          selected={chosen.includes(option)}
          multiple
          disabled={disabled}
          onPress={() =>
            field.setValue(chosen.includes(option) ? chosen.filter((item) => item !== option) : [...chosen, option])
          }
        />
      ))}
    </Field>
  );
}

export function Switch({ props }: NodeProps) {
  const { colors, disabled } = useUiEnv();
  const bidi = useBidi();
  const field = useField<boolean>(String(props.name), props.value, "Switch", false);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: GAP.m, ...bidi.row(String(props.label)) }}>
      <Text style={{ flex: 1, color: colors.foreground, fontSize: FONT.m, ...bidi.text(String(props.label)) }}>{props.label}</Text>
      <RNSwitch
        value={field.value === true}
        onValueChange={field.setValue}
        disabled={disabled}
        trackColor={{ true: colors.accent, false: colors.surface2 }}
      />
    </View>
  );
}

export function Stepper({ props }: NodeProps) {
  const { colors, disabled } = useUiEnv();
  const min = Number(props.min ?? 0);
  const max = Number(props.max ?? 100);
  const step = Number(props.step ?? 1) || 1;
  const field = useField<number>(String(props.name), props.value, "Stepper", min);
  const value = typeof field.value === "number" ? field.value : min;
  const button = (icon: string, next: number, label: string) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled || next < min || next > max}
      onPress={() => field.setValue(next)}
      style={{
        width: 40,
        height: 40,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: RADIUS.s,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
        opacity: disabled || next < min || next > max ? 0.4 : 1,
      }}
    >
      <Icon name={icon} size={16} color={colors.foreground} />
    </Pressable>
  );
  return (
    <Field label={props.label}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: GAP.m }}>
        {button("Minus", value - step, "Decrease")}
        <Text style={{ minWidth: 40, textAlign: "center", color: colors.foreground, fontSize: FONT.l, fontWeight: "600" }}>{value}</Text>
        {button("Plus", value + step, "Increase")}
      </View>
    </Field>
  );
}
