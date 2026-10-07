import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useMemo } from "react";
import { Text } from "react-native";

import { useConductors, useWorkers } from "./data.js";
import { createStyles, type Styles } from "./styles.js";
import { countNeedingAttention } from "./view-model.js";

export function ConductorsSidebarItem({
  theme,
  layout,
  currentScreen,
  openScreen,
}: PluginSidebarItemProps) {
  const styles = useMemo(
    () => createStyles(theme, layout.compact),
    [theme, layout.compact],
  );
  const conductors = useConductors();
  const onConductors = currentScreen?.screenId === "conductors";
  const openConductorId = onConductors
    ? currentScreen.params.agentId
    : undefined;
  return (
    <>
      <SidebarRow
        icon="Workflow"
        label="Conductors"
        active={onConductors && !openConductorId}
        onPress={() => openScreen({ screenId: "conductors" })}
      />
      {conductors.data?.map((conductor) => (
        <ConductorRow
          key={conductor.id}
          conductorId={conductor.id}
          title={conductor.title ?? conductor.id}
          active={conductor.id === openConductorId}
          onPress={() =>
            openScreen({
              screenId: "conductors",
              params: { agentId: conductor.id },
            })
          }
          styles={styles}
        />
      ))}
    </>
  );
}

function ConductorRow({
  conductorId,
  title,
  active,
  onPress,
  styles,
}: {
  conductorId: string;
  title: string;
  active: boolean;
  onPress(): void;
  styles: Styles;
}) {
  const workers = useWorkers(conductorId);
  const attention = countNeedingAttention(workers.data ?? []);
  return (
    <SidebarRow
      id={conductorId}
      icon="Bot"
      label={title}
      active={active}
      onPress={onPress}
      trailing={
        attention > 0 ? (
          <Text style={styles.warning}>{attention}</Text>
        ) : undefined
      }
    />
  );
}
