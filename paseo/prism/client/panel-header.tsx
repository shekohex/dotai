import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";

export function HeaderButton({
  theme,
  icon,
  label,
  onPress,
  active = false,
  disabled = false,
  busy = false,
  compact,
}: {
  theme: PluginTheme;
  icon: string;
  label: string;
  onPress: () => void;
  active?: boolean;
  disabled?: boolean;
  busy?: boolean;
  compact: boolean;
}) {
  const size = compact ? 40 : 28;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active, disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={{
        width: size,
        height: size,
        borderRadius: 6,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.4 : 1,
        backgroundColor: active ? theme.colors.surface2 : "transparent",
      }}
    >
      {busy ? (
        <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
      ) : (
        <Icon
          name={icon}
          size={16}
          color={active ? theme.colors.foreground : theme.colors.foregroundMuted}
        />
      )}
    </Pressable>
  );
}

export function HeaderBar({
  theme,
  compact,
  children,
}: {
  theme: PluginTheme;
  compact: boolean;
  children: ReactNode;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 10,
        minHeight: compact ? 52 : 38,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
      }}
    >
      {children}
    </View>
  );
}
