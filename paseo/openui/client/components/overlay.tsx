import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useBidi } from "../bidi";
import { useContextBridge, useField } from "../runtime";
import { FONT, GAP, RADIUS, useUiEnv } from "../tokens";
import { Panel } from "./pickers";
import type { NodeProps } from "./types";

export function Dialog({ props, renderNode }: NodeProps) {
  const { colors } = useUiEnv();
  const bidi = useBidi();
  const bridge = useContextBridge();
  const field = useField<boolean>(String(props.title), props.open, "Dialog", false);
  const open = field.value === true;
  return (
    <Modal title={String(props.title)} open={open} onOpenChange={(next) => field.setValue(next)}>
      {open
        ? bridge(
            <Modal.Content>
              {props.description ? (
                <Text style={{ color: colors.foregroundMuted, fontSize: FONT.m, ...bidi.text(String(props.description)) }}>{props.description}</Text>
              ) : null}
              {renderNode(props.children)}
            </Modal.Content>,
          )
        : null}
    </Modal>
  );
}

export function Popover({ props, renderNode }: NodeProps) {
  const { colors, disabled } = useUiEnv();
  const bidi = useBidi();
  const [open, setOpen] = useState(false);
  const label = String(props.label);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open, disabled }}
        disabled={disabled}
        onPress={() => setOpen(!open)}
        style={{
          alignSelf: "flex-start",
          minHeight: 40,
          flexDirection: "row",
          alignItems: "center",
          gap: GAP.s,
          paddingHorizontal: GAP.l,
          borderRadius: RADIUS.s,
          borderWidth: 1,
          borderColor: open ? colors.accent : colors.border,
          backgroundColor: colors.surface2,
          opacity: disabled ? 0.45 : 1,
          ...bidi.row(label),
        }}
      >
        {props.icon ? <Icon name={String(props.icon)} size={16} color={colors.foreground} /> : null}
        <Text style={{ color: colors.foreground, fontSize: FONT.m, fontWeight: "600", ...bidi.text(label) }}>{label}</Text>
        <Icon name={open ? "ChevronUp" : "ChevronDown"} size={16} color={colors.foregroundMuted} />
      </Pressable>
      {open ? <Panel>{renderNode(props.children)}</Panel> : null}
    </View>
  );
}

const TOOLTIP_MS = 2800;

export function Tooltip({ props, renderNode }: NodeProps) {
  const { colors } = useUiEnv();
  const bidi = useBidi();
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const hint = String(props.text);
  const show = (on: boolean, autoHide: boolean) => {
    if (timer.current) clearTimeout(timer.current);
    setShown(on);
    if (on && autoHide) timer.current = setTimeout(() => setShown(false), TOOLTIP_MS);
  };
  return (
    <View style={{ alignSelf: "flex-start", zIndex: shown ? 10 : 0 }}>
      <Pressable
        accessibilityHint={hint}
        onPress={() => show(!shown, true)}
        onHoverIn={() => show(true, false)}
        onHoverOut={() => show(false, false)}
      >
        {renderNode(props.child)}
      </Pressable>
      {shown ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            bottom: "100%",
            marginBottom: GAP.xs,
            left: 0,
            maxWidth: 240,
            minWidth: 120,
            paddingHorizontal: GAP.m,
            paddingVertical: GAP.s,
            borderRadius: RADIUS.s,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface2,
          }}
        >
          <Text style={{ color: colors.foreground, fontSize: FONT.s + 1, ...bidi.text(hint) }}>{hint}</Text>
        </View>
      ) : null}
    </View>
  );
}
