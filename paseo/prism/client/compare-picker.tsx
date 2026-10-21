import type { PluginTheme } from "@getpaseo/plugin";
import { FlatList, Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";

import type { Compare } from "../shared/contracts.js";
import { useBranches } from "./data.js";
import { rowHeight, withAlpha, type Typography } from "./styling.js";

const MODES: { mode: Compare["mode"]; title: string; hint: string }[] = [
  { mode: "uncommitted", title: "Uncommitted", hint: "Working tree against HEAD" },
  { mode: "committed", title: "Committed", hint: "Commits on this branch against the base" },
  { mode: "all", title: "All changes", hint: "Working tree against the base" },
];

export function compareLabel(applied: Compare): string {
  if (applied.mode === "uncommitted") return "Uncommitted";
  return `${applied.mode === "committed" ? "Committed" : "All"} vs ${applied.baseRef ?? "base"}`;
}

function Option({
  theme,
  compact,
  typo,
  title,
  hint,
  selected,
  onPress,
}: {
  theme: PluginTheme;
  compact: boolean;
  typo: Typography;
  title: string;
  hint?: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={{
        minHeight: rowHeight(compact),
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 6,
        backgroundColor: selected ? withAlpha(theme.colors.accent, 0.18) : "transparent",
      }}
    >
      <View style={{ width: 16 }}>
        {selected ? <Icon name="Check" size={14} color={theme.colors.accent} /> : null}
      </View>
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: typo.ui }}>
          {title}
        </Text>
        {hint ? (
          <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: typo.small }}>
            {hint}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/** Replaces the file list while open: pick what to compare, and against which branch. */
export function ComparePicker({
  theme,
  compact,
  typo,
  workspaceId,
  compare,
  defaultBase,
  onChange,
  onClose,
}: {
  theme: PluginTheme;
  compact: boolean;
  typo: Typography;
  workspaceId: string;
  compare: Compare;
  defaultBase: string | null;
  onChange: (compare: Compare) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const branches = useBranches(workspaceId, true);
  const needsBase = compare.mode !== "uncommitted";
  const base = compare.baseRef ?? defaultBase;
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    const all = branches.data?.branches ?? [];
    return query === "" ? all : all.filter((name) => name.toLowerCase().includes(query));
  }, [branches.data, search]);

  return (
    <View style={{ flex: 1 }}>
      {MODES.map((entry) => (
        <Option
          key={entry.mode}
          theme={theme}
          compact={compact}
          typo={typo}
          title={entry.title}
          hint={entry.hint}
          selected={compare.mode === entry.mode}
          onPress={() => {
            onChange({ mode: entry.mode, baseRef: compare.baseRef });
            if (entry.mode === "uncommitted") onClose();
          }}
        />
      ))}
      {needsBase ? (
        <>
          <View style={{ height: 1, backgroundColor: theme.colors.border, marginVertical: 4 }} />
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: typo.small, paddingHorizontal: 12, paddingVertical: 4 }}>
            {`Base branch${base ? `: ${base}` : ""}`}
          </Text>
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search branches"
            placeholderTextColor={theme.colors.foregroundMuted}
            autoCapitalize="none"
            autoCorrect={false}
            style={{
              color: theme.colors.foreground,
              fontSize: typo.ui,
              paddingHorizontal: 12,
              paddingVertical: compact ? 10 : 6,
              borderBottomWidth: 1,
              borderBottomColor: theme.colors.border,
            }}
          />
          <FlatList
            data={visible}
            keyExtractor={(name) => name}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <Option
                theme={theme}
                compact={compact}
                typo={typo}
                title={item}
                hint={item === defaultBase ? "Default branch" : undefined}
                selected={item === base}
                onPress={() => {
                  onChange({ mode: compare.mode, baseRef: item });
                  onClose();
                }}
              />
            )}
            ListEmptyComponent={
              <Text style={{ color: theme.colors.foregroundMuted, padding: 12, fontSize: typo.ui }}>
                {branches.isPending ? "Loading branches…" : "No matching branches"}
              </Text>
            }
          />
        </>
      ) : null}
    </View>
  );
}
