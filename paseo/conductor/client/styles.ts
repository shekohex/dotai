import type { PluginTheme } from "@getpaseo/plugin";
import { StyleSheet } from "react-native";

/** Paseo design tokens (packages/app/src/styles/theme.ts); plugins only receive colors. */
export const SPACING = {
  0.5: 2,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  6: 24,
  8: 32,
} as const;
export const FONT_SIZE = { sm: 12, base: 14 } as const;
export const ICON_SIZE = { sm: 14, md: 16 } as const;
export const LIST_WIDTH = 320;
export const DETAIL_MAX_WIDTH = 720;

export function createStyles(theme: PluginTheme, compact: boolean) {
  const { colors } = theme;
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.surface0 },
    shell: { flex: 1, flexDirection: "row" },
    list: {
      width: LIST_WIDTH,
      borderRightWidth: 1,
      borderRightColor: colors.border,
      backgroundColor: colors.surface1,
    },
    listContent: { padding: SPACING[3], gap: SPACING[0.5] },
    listLabel: {
      color: colors.foregroundMuted,
      fontSize: FONT_SIZE.sm,
      fontWeight: "500",
      marginTop: SPACING[4],
      marginBottom: SPACING[2],
      marginLeft: SPACING[3],
    },
    listRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: SPACING[2],
      paddingVertical: SPACING[2],
      paddingHorizontal: SPACING[3],
      borderRadius: 8,
    },
    listRowActive: { backgroundColor: colors.surface2 },
    detail: { flex: 1 },
    detailContent: {
      paddingHorizontal: compact ? SPACING[4] : SPACING[6],
      paddingVertical: compact ? SPACING[4] : SPACING[8],
    },
    column: { width: "100%", maxWidth: DETAIL_MAX_WIDTH, alignSelf: "center" },
    row: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingVertical: SPACING[4],
      paddingHorizontal: SPACING[4],
    },
    rowPressed: { backgroundColor: colors.surface2 },
    rowBorder: { borderTopWidth: 1, borderTopColor: colors.border },
    rowContent: { flex: 1, minWidth: 0, marginRight: SPACING[3] },
    rowTitle: { color: colors.foreground, fontSize: FONT_SIZE.base },
    rowHint: {
      color: colors.foregroundMuted,
      fontSize: FONT_SIZE.sm,
      marginTop: SPACING[1],
    },
    rowError: {
      color: colors.statusDanger,
      fontSize: FONT_SIZE.sm,
      marginTop: SPACING[1],
    },
    trailing: { flexDirection: "row", alignItems: "center", gap: SPACING[2] },
    title: {
      color: colors.foreground,
      fontSize: FONT_SIZE.base,
      flexShrink: 1,
    },
    muted: { color: colors.foregroundMuted, fontSize: FONT_SIZE.sm },
    success: { color: colors.statusSuccess, fontSize: FONT_SIZE.sm },
    warning: { color: colors.statusWarning, fontSize: FONT_SIZE.sm },
    danger: { color: colors.statusDanger, fontSize: FONT_SIZE.sm },
    empty: {
      color: colors.foregroundMuted,
      fontSize: FONT_SIZE.base,
      textAlign: "center",
      paddingVertical: SPACING[8],
    },
    editor: { paddingHorizontal: SPACING[4], paddingBottom: SPACING[4] },
    editorInput: {
      minHeight: 200,
      color: colors.foreground,
      backgroundColor: colors.surface0,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 6,
      padding: SPACING[3],
      fontFamily: "monospace",
      fontSize: FONT_SIZE.sm,
      textAlignVertical: "top",
    },
    modalText: { color: colors.foregroundMuted, fontSize: FONT_SIZE.base },
  });
}

export type Styles = ReturnType<typeof createStyles>;
