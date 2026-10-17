import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { type Cell, pageCount, pageRows, searchRows, sortRows } from "../../shared/table";
import { useBidi } from "../bidi";
import { FONT, GAP, RADIUS, useUiEnv } from "../tokens";
import type { NodeProps } from "./types";

const SEARCH_FROM = 8;
const DEFAULT_PAGE = 10;

function cells(value: unknown): Cell[] {
  return Array.isArray(value) ? (value as Cell[]) : [];
}

function show(cell: Cell): string {
  return cell === null || cell === undefined ? "" : String(cell);
}

export function DataTable({ props }: NodeProps) {
  const { colors } = useUiEnv();
  const bidi = useBidi();
  const headers = cells(props.headers).map(show);
  const rows = cells(props.rows).map(cells);
  const pageSize = Math.max(1, Number(props.pageSize ?? DEFAULT_PAGE) || DEFAULT_PAGE);
  const searchable = props.search ?? rows.length > SEARCH_FROM;
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ column: number; direction: "asc" | "desc" } | null>(null);
  const [page, setPage] = useState(0);
  const found = searchRows(rows, query);
  const ordered = sortRows(found, sort ? sort.column : null, sort ? sort.direction : "asc");
  const pages = pageCount(ordered.length, pageSize);
  const current = Math.min(page, pages - 1);
  const visible = pageRows(ordered, current, pageSize);
  const scroll = headers.length > 3;
  const width = scroll ? 132 : undefined;
  const cycle = (column: number) => {
    setPage(0);
    if (sort?.column !== column) setSort({ column, direction: "asc" });
    else if (sort.direction === "asc") setSort({ column, direction: "desc" });
    else setSort(null);
  };
  const first = ordered.length === 0 ? 0 : current * pageSize + 1;
  const last = Math.min(ordered.length, (current + 1) * pageSize);
  const pager = (icon: string, target: number, label: string) => {
    const blocked = target < 0 || target >= pages;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        disabled={blocked}
        onPress={() => setPage(target)}
        style={{ padding: GAP.s, opacity: blocked ? 0.3 : 1 }}
      >
        <Icon name={icon} size={18} color={colors.foreground} />
      </Pressable>
    );
  };
  const table = (
    <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: RADIUS.s, overflow: "hidden", ...bidi.row(headers.join(" ")) }}>
      <View style={{ flexDirection: "row", backgroundColor: colors.surface1 }}>
        {headers.map((header, column) => {
          const active = sort?.column === column;
          return (
            <Pressable
              key={column}
              accessibilityRole="button"
              accessibilityLabel={`Sort by ${header}`}
              accessibilityState={{ selected: active }}
              onPress={() => cycle(column)}
              style={{ width, flex: scroll ? undefined : 1, flexDirection: "row", alignItems: "center", gap: GAP.xs, padding: GAP.s }}
            >
              <Text style={{ flexShrink: 1, color: colors.foreground, fontSize: FONT.s + 1, fontWeight: "600", ...bidi.text(header) }}>{header}</Text>
              <Icon
                name={active ? (sort.direction === "asc" ? "ArrowUp" : "ArrowDown") : "ArrowUpDown"}
                size={13}
                color={active ? colors.accent : colors.foregroundMuted}
              />
            </Pressable>
          );
        })}
      </View>
      {visible.length === 0 ? (
        <Text style={{ padding: GAP.m, color: colors.foregroundMuted, fontSize: FONT.m, borderTopWidth: 1, borderTopColor: colors.border }}>No rows</Text>
      ) : (
        visible.map((row, rowIndex) => (
          <View key={rowIndex} style={{ flexDirection: "row", borderTopWidth: 1, borderTopColor: colors.border }}>
            {headers.map((_, column) => (
              <Text
                key={column}
                selectable
                style={{ width, flex: scroll ? undefined : 1, padding: GAP.s, color: colors.foreground, fontSize: FONT.m, ...bidi.text(show(row[column])) }}
              >
                {show(row[column])}
              </Text>
            ))}
          </View>
        ))
      )}
    </View>
  );
  return (
    <View style={{ gap: GAP.s }}>
      {searchable ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: GAP.s, paddingHorizontal: GAP.m, borderWidth: 1, borderColor: colors.border, borderRadius: RADIUS.s, backgroundColor: colors.surface0 }}>
          <Icon name="Search" size={16} color={colors.foregroundMuted} />
          <TextInput
            value={query}
            onChangeText={(text) => {
              setQuery(text);
              setPage(0);
            }}
            placeholder="Search…"
            placeholderTextColor={colors.foregroundMuted}
            autoCapitalize="none"
            autoCorrect={false}
            style={{ flex: 1, minHeight: 38, color: colors.foreground, fontSize: FONT.m, ...bidi.text(query || "Search") }}
          />
        </View>
      ) : null}
      {scroll ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {table}
        </ScrollView>
      ) : (
        table
      )}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ flex: 1, color: colors.foregroundMuted, fontSize: FONT.s, ...bidi.text(String(props.caption ?? "")) }}>
          {props.caption ? `${props.caption} · ` : ""}
          {`${first}–${last} of ${ordered.length}`}
        </Text>
        {pages > 1 ? (
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            {pager("ChevronLeft", current - 1, "Previous page")}
            <Text style={{ color: colors.foreground, fontSize: FONT.s }}>{`${current + 1} / ${pages}`}</Text>
            {pager("ChevronRight", current + 1, "Next page")}
          </View>
        ) : null}
      </View>
    </View>
  );
}
