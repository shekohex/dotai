import { type PluginAgentPanelProps, useAgent } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useMemo } from "react";
import { Text, View } from "react-native";

import { isConductor, PARENT_AGENT_LABEL } from "../shared/labels.js";
import { ConductorDetail } from "./dashboard.js";
import { createStyles } from "./styles.js";

/** Shows the focused conductor, or the conductor that owns the focused worker. */
export function ConductorPanel({
  theme,
  layout,
  agentId,
  navigation,
}: PluginAgentPanelProps) {
  const styles = useMemo(
    () => createStyles(theme, layout.compact),
    [theme, layout.compact],
  );
  const labels = useAgent(agentId, (agent) => agent.labels);
  const parentId = labels?.[PARENT_AGENT_LABEL] ?? "";
  const parentLabels = useAgent(parentId, (agent) => agent.labels);
  const conductorId =
    labels && isConductor(labels)
      ? agentId
      : parentLabels && isConductor(parentLabels)
        ? parentId
        : null;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.detailContent}
    >
      <View style={styles.column}>
        {conductorId ? (
          <ConductorDetail
            conductorId={conductorId}
            navigation={navigation}
            styles={styles}
            theme={theme}
          />
        ) : (
          <Text style={styles.empty}>
            Not a conductor or one of its workers
          </Text>
        )}
      </View>
    </ScrollView>
  );
}
