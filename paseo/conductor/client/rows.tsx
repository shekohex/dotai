import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

import { ICON_SIZE, type Styles } from "./styles.js";

interface RowProps {
  title: string;
  hint?: string | undefined;
  error?: string | null | undefined;
  trailing?: ReactNode;
  styles: Styles;
  theme: PluginTheme;
}

function RowContent({
  title,
  hint,
  error,
  styles,
}: Omit<RowProps, "trailing" | "theme">) {
  return (
    <View style={styles.rowContent}>
      <Text style={styles.rowTitle} numberOfLines={1}>
        {title}
      </Text>
      {hint ? (
        <Text style={styles.rowHint} numberOfLines={2}>
          {hint}
        </Text>
      ) : null}
      {error ? <Text style={styles.rowError}>{error}</Text> : null}
    </View>
  );
}

/** A card row that drills into something else: whole row pressable, trailing chevron. */
export function NavigationRow({
  onPress,
  trailing,
  ...row
}: RowProps & { onPress(): void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        row.styles.row,
        pressed && row.styles.rowPressed,
      ]}
    >
      <RowContent {...row} />
      <View style={row.styles.trailing}>
        {trailing}
        <Icon
          name="ChevronRight"
          size={ICON_SIZE.sm}
          color={row.theme.colors.foregroundMuted}
        />
      </View>
    </Pressable>
  );
}

/** A card row that expands in place; the chevron rotates down when open. */
export function CollapsibleRow({
  open,
  onToggle,
  trailing,
  children,
  ...row
}: RowProps & { open: boolean; onToggle(): void; children: ReactNode }) {
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        style={({ pressed }) => [
          row.styles.row,
          pressed && row.styles.rowPressed,
        ]}
      >
        <RowContent {...row} />
        <View style={row.styles.trailing}>
          {trailing}
          <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
            <Icon
              name="ChevronRight"
              size={ICON_SIZE.sm}
              color={row.theme.colors.foregroundMuted}
            />
          </View>
        </View>
      </Pressable>
      {open ? children : null}
    </View>
  );
}

export function EmptyRow({ label, styles }: { label: string; styles: Styles }) {
  return (
    <View style={styles.row}>
      <Text style={styles.muted}>{label}</Text>
    </View>
  );
}
