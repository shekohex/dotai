import type { PluginTheme } from "@getpaseo/plugin";
import {
  type PluginScreenProps,
  usePaseo,
  useSettings,
} from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { conductorSettings } from "../shared/settings.js";
import { ConductorDetail } from "./dashboard.js";
import { useConductors, useWorkers } from "./data.js";
import { MemorySections } from "./memory-sections.js";
import { NewConductorForm } from "./new-conductor.js";
import { createStyles, ICON_SIZE, SPACING, type Styles } from "./styles.js";
import { countNeedingAttention } from "./view-model.js";

type Selection =
  { kind: "conductor"; id: string } | { kind: "new" } | { kind: "memory" };

function selectionFromParams(
  params: PluginScreenProps["params"],
): Selection | null {
  if (params.agentId) return { kind: "conductor", id: params.agentId };
  if (params.view === "new" || params.workspaceId) return { kind: "new" };
  if (params.view === "memory") return { kind: "memory" };
  return null;
}

function isSelected(
  selection: Selection | null,
  candidate: Selection,
): boolean {
  if (!selection || selection.kind !== candidate.kind) return false;
  return (
    selection.kind !== "conductor" ||
    (candidate.kind === "conductor" && selection.id === candidate.id)
  );
}

/**
 * List+detail shell from Paseo's design guide: a 320px list beside a centered 720px detail on wide
 * layouts; on compact layouts the list is the screen and a row pushes its detail.
 */
export function ConductorsScreen({
  theme,
  layout,
  params,
  navigation,
}: PluginScreenProps) {
  const styles = useMemo(
    () => createStyles(theme, layout.compact),
    [theme, layout.compact],
  );
  const conductors = useConductors();
  const [selection, setSelection] = useState(() => selectionFromParams(params));

  const { agentId, view, workspaceId } = params;
  // Follow navigation (sidebar rows, Command Center) without undoing clicks in the list.
  useEffect(() => {
    const next = selectionFromParams({
      ...(agentId ? { agentId } : {}),
      ...(view ? { view } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    });
    if (next) setSelection(next);
  }, [agentId, view, workspaceId]);

  const firstConductor = conductors.data?.[0];
  const wideDefault: Selection | null = firstConductor
    ? { kind: "conductor", id: firstConductor.id }
    : conductors.data
      ? { kind: "new" }
      : null;
  const active = selection ?? (layout.compact ? null : wideDefault);

  const list = (
    <ConductorList
      selection={active}
      onSelect={setSelection}
      compact={layout.compact}
      styles={styles}
      theme={theme}
    />
  );
  const detail = active ? (
    <SelectionDetail
      selection={active}
      initialWorkspaceId={params.workspaceId}
      onCreated={(agentId) => {
        setSelection({ kind: "conductor", id: agentId });
        navigation?.openAgent({ agentId });
      }}
      navigation={navigation}
      styles={styles}
      theme={theme}
    />
  ) : null;

  if (layout.compact) {
    return active ? (
      <ScrollView
        style={styles.screen}
        contentContainerStyle={styles.detailContent}
      >
        <BackRow
          onPress={() => setSelection(null)}
          styles={styles}
          theme={theme}
        />
        {detail}
      </ScrollView>
    ) : (
      <ScrollView
        style={styles.screen}
        contentContainerStyle={styles.listContent}
      >
        {list}
      </ScrollView>
    );
  }

  return (
    <View style={[styles.screen, styles.shell]}>
      <ScrollView
        style={styles.list}
        contentContainerStyle={styles.listContent}
      >
        {list}
      </ScrollView>
      <ScrollView
        style={styles.detail}
        contentContainerStyle={styles.detailContent}
      >
        <View style={styles.column}>
          {detail ?? <Text style={styles.empty}>Select a conductor</Text>}
        </View>
      </ScrollView>
    </View>
  );
}

function SelectionDetail({
  selection,
  initialWorkspaceId,
  onCreated,
  navigation,
  styles,
  theme,
}: {
  selection: Selection;
  initialWorkspaceId: string | undefined;
  onCreated(agentId: string): void;
  navigation: PluginScreenProps["navigation"];
  styles: Styles;
  theme: PluginTheme;
}) {
  if (selection.kind === "new") {
    return (
      <NewConductorForm
        initialWorkspaceId={initialWorkspaceId}
        onCreated={onCreated}
      />
    );
  }
  if (selection.kind === "memory")
    return <MemoryDetail styles={styles} theme={theme} />;
  return (
    <ConductorDetail
      key={selection.id}
      conductorId={selection.id}
      navigation={navigation}
      styles={styles}
      theme={theme}
    />
  );
}

function ConductorList({
  selection,
  onSelect,
  compact,
  styles,
  theme,
}: {
  selection: Selection | null;
  onSelect(selection: Selection): void;
  compact: boolean;
  styles: Styles;
  theme: PluginTheme;
}) {
  const conductors = useConductors();
  const rowProps = { compact, styles, theme };
  return (
    <>
      <Text style={styles.listLabel}>Conductors</Text>
      {conductors.data?.map((conductor) => {
        const candidate: Selection = { kind: "conductor", id: conductor.id };
        return (
          <ListRow
            key={conductor.id}
            icon="Bot"
            title={conductor.title ?? conductor.id}
            active={isSelected(selection, candidate)}
            trailing={
              <AttentionCount conductorId={conductor.id} styles={styles} />
            }
            onPress={() => onSelect(candidate)}
            {...rowProps}
          />
        );
      })}
      {conductors.data?.length === 0 ? (
        <Text
          style={[
            styles.muted,
            { marginLeft: SPACING[3], marginBottom: SPACING[2] },
          ]}
        >
          No conductors yet
        </Text>
      ) : null}
      <ListRow
        icon="Plus"
        title="New conductor"
        active={selection?.kind === "new"}
        onPress={() => onSelect({ kind: "new" })}
        {...rowProps}
      />
      <Text style={styles.listLabel}>Memory</Text>
      <ListRow
        icon="BookOpen"
        title="Memory and instructions"
        active={selection?.kind === "memory"}
        onPress={() => onSelect({ kind: "memory" })}
        {...rowProps}
      />
    </>
  );
}

function ListRow({
  icon,
  title,
  active,
  trailing,
  onPress,
  compact,
  styles,
  theme,
}: {
  icon: string;
  title: string;
  active: boolean;
  trailing?: ReactNode;
  onPress(): void;
  compact: boolean;
  styles: Styles;
  theme: PluginTheme;
}) {
  const [hovered, setHovered] = useState(false);
  const highlighted = active || hovered;
  const color = highlighted
    ? theme.colors.foreground
    : theme.colors.foregroundMuted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => [
        styles.listRow,
        (highlighted || pressed) && styles.listRowActive,
      ]}
    >
      <Icon name={icon} size={ICON_SIZE.sm} color={color} />
      <Text style={[styles.title, { color, flex: 1 }]} numberOfLines={1}>
        {title}
      </Text>
      {trailing}
      {compact ? (
        <Icon
          name="ChevronRight"
          size={ICON_SIZE.sm}
          color={theme.colors.foregroundMuted}
        />
      ) : null}
    </Pressable>
  );
}

function AttentionCount({
  conductorId,
  styles,
}: {
  conductorId: string;
  styles: Styles;
}) {
  const workers = useWorkers(conductorId);
  const count = countNeedingAttention(workers.data ?? []);
  return count > 0 ? <Text style={styles.warning}>{count}</Text> : null;
}

function BackRow({
  onPress,
  styles,
  theme,
}: {
  onPress(): void;
  styles: Styles;
  theme: PluginTheme;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[
        styles.trailing,
        {
          alignSelf: "flex-start",
          paddingVertical: SPACING[2],
          marginBottom: SPACING[4],
        },
      ]}
    >
      <Icon
        name="ChevronLeft"
        size={ICON_SIZE.sm}
        color={theme.colors.foregroundMuted}
      />
      <Text style={styles.muted}>Conductors</Text>
    </Pressable>
  );
}

function MemoryDetail({
  styles,
  theme,
}: {
  styles: Styles;
  theme: PluginTheme;
}) {
  const paseo = usePaseo();
  const settings = useSettings(conductorSettings);
  const workspaces = useQuery({
    queryKey: ["conductor", "workspaces"],
    queryFn: async () => (await paseo.workspaces.list()).entries,
  });
  const [picked, setPicked] = useState<string | null>(null);
  const ids = (workspaces.data ?? []).map((workspace) => workspace.id);
  const saved =
    settings.status === "ready" ? settings.values.lastWorkspaceId : "";
  const workspaceId =
    [picked, saved].find((id) => id && ids.includes(id)) ?? ids[0];

  return (
    <MemorySections
      {...(workspaceId ? { workspaceId } : {})}
      workspacePicker={
        <SettingsSelect
          label="Workspace"
          hint="Whose CONDUCTOR.md to edit"
          value={workspaceId ?? ""}
          options={(workspaces.data ?? []).map((workspace) => ({
            label: `${workspace.projectDisplayName} · ${workspace.name}`,
            value: workspace.id,
          }))}
          onValueChange={setPicked}
          disabled={!workspaces.data?.length}
        />
      }
      styles={styles}
      theme={theme}
    />
  );
}
