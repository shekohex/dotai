import type { PluginTheme } from "@getpaseo/plugin";
import { FlatList, Icon } from "@getpaseo/plugin/client/react-native";
import { memo, useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";

import type { TreeRow } from "../shared/tree.js";
import { FileIcon } from "./file-icon.js";
import { rowHeight, withAlpha, type Typography } from "./styling.js";

export interface RowDecoration {
  letter: string;
  color: string;
  additions: number;
  deletions: number;
  comments?: number;
  /** Fades the row, for files git ignores. */
  dim?: boolean;
}

interface TreeListProps {
  theme: PluginTheme;
  compact: boolean;
  typo: Typography;
  rows: readonly TreeRow[];
  selectedPath: string | null;
  decorate: (row: TreeRow) => RowDecoration | null;
  onPressFile: (path: string) => void;
  onToggleDir: (path: string) => void;
  empty: string;
}

interface RowProps extends Omit<TreeListProps, "rows" | "selectedPath" | "empty" | "decorate"> {
  row: TreeRow;
  selected: boolean;
  decoration: RowDecoration | null;
}

const INDENT = 14;

const Row = memo(function Row({
  theme,
  compact,
  typo,
  row,
  selected,
  decoration,
  onPressFile,
  onToggleDir,
}: RowProps) {
  const styles = useMemo(
    () => ({
      row: {
        height: rowHeight(compact),
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        paddingRight: 10,
        opacity: decoration?.dim ? 0.5 : 1,
        backgroundColor: selected ? withAlpha(theme.colors.accent, 0.18) : "transparent",
      },
      name: {
        flex: 1,
        color: row.isDir ? theme.colors.foregroundMuted : theme.colors.foreground,
        fontSize: typo.ui,
      },
      letter: {
        width: 14,
        textAlign: "center" as const,
        fontSize: typo.small,
        fontFamily: typo.mono,
        fontWeight: "700" as const,
      },
      count: { fontSize: typo.small, fontFamily: typo.mono },
    }),
    [theme, compact, typo, row.isDir, selected, decoration?.dim],
  );
  const onPress = useCallback(
    () => (row.isDir ? onToggleDir(row.path) : onPressFile(row.path)),
    [row.isDir, row.path, onPressFile, onToggleDir],
  );
  const iconColor = theme.colors.foregroundMuted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={row.name}
      onPress={onPress}
      style={[styles.row, { paddingLeft: 8 + row.depth * INDENT }]}
    >
      {row.isDir ? (
        <Icon name={row.expanded ? "ChevronDown" : "ChevronRight"} size={14} color={iconColor} />
      ) : (
        <View style={{ width: 14 }} />
      )}
      <FileIcon theme={theme} name={row.name} isDir={row.isDir} expanded={row.expanded} />
      <Text numberOfLines={1} style={styles.name}>
        {row.name}
      </Text>
      {decoration ? (
        <>
          {decoration.comments ? (
            <Text style={[styles.count, { color: theme.colors.accent }]}>{`💬${decoration.comments}`}</Text>
          ) : null}
          {decoration.additions > 0 ? (
            <Text style={[styles.count, { color: theme.colors.statusSuccess }]}>
              {`+${decoration.additions}`}
            </Text>
          ) : null}
          {decoration.deletions > 0 ? (
            <Text style={[styles.count, { color: theme.colors.statusDanger }]}>
              {`-${decoration.deletions}`}
            </Text>
          ) : null}
          {decoration.letter !== "" ? (
            <Text style={[styles.letter, { color: decoration.color }]}>{decoration.letter}</Text>
          ) : null}
        </>
      ) : null}
    </Pressable>
  );
});

export function TreeList({
  theme,
  compact,
  typo,
  rows,
  selectedPath,
  decorate,
  onPressFile,
  onToggleDir,
  empty,
}: TreeListProps) {
  const height = rowHeight(compact);
  const renderItem = useCallback(
    ({ item }: { item: TreeRow }) => (
      <Row
        theme={theme}
        compact={compact}
        typo={typo}
        row={item}
        selected={item.path === selectedPath}
        decoration={decorate(item)}
        onPressFile={onPressFile}
        onToggleDir={onToggleDir}
      />
    ),
    [theme, compact, typo, selectedPath, decorate, onPressFile, onToggleDir],
  );
  return (
    <FlatList
      data={rows}
      renderItem={renderItem}
      keyExtractor={(row) => row.key}
      getItemLayout={(_data, index) => ({ length: height, offset: height * index, index })}
      initialNumToRender={30}
      windowSize={9}
      maxToRenderPerBatch={30}
      ListEmptyComponent={
        <Text style={{ color: theme.colors.foregroundMuted, padding: 16, fontSize: typo.ui }}>
          {empty}
        </Text>
      }
    />
  );
}
