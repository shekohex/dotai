import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { ConductorDetail } from "./dashboard.js";
import { useConductors, useWorkspaceConductors } from "./data.js";
import { ProgressView } from "./progress/view.js";
import { createStyles, SPACING, type Styles } from "./styles.js";

/**
 * Workspace panels, so they show in the explorer's + menu (Paseo lists only workspace-context
 * plugin panels there). They follow the conductors working in the workspace: the conductor
 * itself, or the conductor of a worker running here.
 */
function WorkspaceConductorPanel({
  theme,
  layout,
  workspaceId,
  empty,
  edgeToEdge = false,
  children,
}: PluginWorkspacePanelProps & {
  empty: string;
  /** Full-width content that pads its own cards, like the progress dashboard. */
  edgeToEdge?: boolean;
  children(conductorId: string, styles: Styles): ReactNode;
}) {
  const styles = useMemo(
    () => createStyles(theme, layout.compact),
    [theme, layout.compact],
  );
  const conductorIds = useWorkspaceConductors(workspaceId).data ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const conductorId =
    picked && conductorIds.includes(picked) ? picked : conductorIds[0];

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={edgeToEdge ? undefined : styles.detailContent}
    >
      <View
        style={[
          styles.column,
          edgeToEdge ? { paddingHorizontal: 0, paddingTop: SPACING[1] } : null,
        ]}
      >
        {conductorIds.length > 1 ? (
          <ConductorPicker
            ids={conductorIds}
            selected={conductorId}
            onSelect={setPicked}
            styles={styles}
            theme={theme}
          />
        ) : null}
        {conductorId ? (
          children(conductorId, styles)
        ) : (
          <Text style={styles.empty}>{empty}</Text>
        )}
      </View>
    </ScrollView>
  );
}

function ConductorPicker({
  ids,
  selected,
  onSelect,
  styles,
  theme,
}: {
  ids: string[];
  selected: string | undefined;
  onSelect(id: string): void;
  styles: Styles;
  theme: PluginTheme;
}) {
  const conductors = useConductors().data ?? [];
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        gap: SPACING[2],
        marginBottom: SPACING[3],
      }}
    >
      {ids.map((id) => {
        const active = id === selected;
        return (
          <Pressable
            key={id}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => onSelect(id)}
            style={{
              borderWidth: 1,
              borderColor: active ? theme.colors.accent : theme.colors.border,
              borderRadius: 8,
              paddingHorizontal: SPACING[3],
              paddingVertical: SPACING[1],
            }}
          >
            <Text style={active ? styles.rowTitle : styles.muted}>
              {conductors.find((agent) => agent.id === id)?.title ??
                id.slice(0, 7)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Conductor detail (workers, progress, memory) for this workspace's conductor. */
export function ConductorPanel(props: PluginWorkspacePanelProps) {
  return (
    <WorkspaceConductorPanel
      {...props}
      empty="No conductor works in this workspace"
    >
      {(conductorId, styles) => (
        <ConductorDetail
          conductorId={conductorId}
          navigation={props.navigation}
          styles={styles}
          theme={props.theme}
        />
      )}
    </WorkspaceConductorPanel>
  );
}

/** Only the progress dashboard, beside Files and Changes. */
export function ProgressPanel(props: PluginWorkspacePanelProps) {
  return (
    <WorkspaceConductorPanel
      {...props}
      empty="No conductor works in this workspace, so there is no progress here"
      edgeToEdge
    >
      {(conductorId) => (
        <ProgressView
          conductorId={conductorId}
          theme={props.theme}
          workspaceId={props.workspaceId}
          navigation={props.navigation}
        />
      )}
    </WorkspaceConductorPanel>
  );
}
