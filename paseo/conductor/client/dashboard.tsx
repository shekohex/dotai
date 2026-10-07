import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsSection } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";

import { useConductors, useWorkers } from "./data.js";
import { MemorySections } from "./memory-sections.js";
import { EmptyRow, NavigationRow } from "./rows.js";
import type { Styles } from "./styles.js";
import {
  groupWorkers,
  relativeTime,
  type WorkerGroupId,
} from "./view-model.js";
import { errorMessage } from "./errors.js";

type Navigation = PluginScreenProps["navigation"];

const STATUS: Record<
  WorkerGroupId,
  { label: string; tone: "warning" | "success" | "danger" | "muted" }
> = {
  "needs-you": { label: "Needs you", tone: "warning" },
  working: { label: "Working", tone: "success" },
  errored: { label: "Errored", tone: "danger" },
  idle: { label: "Idle", tone: "muted" },
  closed: { label: "Closed", tone: "muted" },
};

/** Everything about one conductor: its conversation, workers grouped by state, and memory. */
export function ConductorDetail({
  conductorId,
  navigation,
  styles,
  theme,
}: {
  conductorId: string;
  navigation: Navigation;
  styles: Styles;
  theme: PluginTheme;
}) {
  const conductors = useConductors();
  const workers = useWorkers(conductorId);
  const conductor = conductors.data?.find((agent) => agent.id === conductorId);
  const groups = groupWorkers(workers.data ?? []);
  const now = Date.now();
  const conductorHint = conductor
    ? [conductor.provider, conductor.model, conductor.status]
        .filter(Boolean)
        .join(" · ")
    : undefined;

  return (
    <View>
      <SettingsSection title="Conductor">
        <SettingsCard>
          {navigation ? (
            <NavigationRow
              title={conductor?.title ?? "Conductor"}
              hint={conductorHint}
              trailing={<Text style={styles.muted}>Open chat</Text>}
              onPress={() => navigation.openAgent({ agentId: conductorId })}
              styles={styles}
              theme={theme}
            />
          ) : (
            <EmptyRow label={conductor?.title ?? "Conductor"} styles={styles} />
          )}
        </SettingsCard>
      </SettingsSection>

      {groups.length === 0 ? (
        <SettingsSection title="Workers">
          <SettingsCard>
            {workers.error ? (
              <Text style={[styles.row, styles.rowError]}>
                {errorMessage(workers.error)}
              </Text>
            ) : (
              <EmptyRow
                label={workers.isPending ? "Loading..." : "No workers yet"}
                styles={styles}
              />
            )}
          </SettingsCard>
        </SettingsSection>
      ) : (
        groups.map((group) => (
          <SettingsSection
            key={group.id}
            title={`${STATUS[group.id].label} · ${group.workers.length}`}
          >
            <SettingsCard>
              {group.workers.map((worker) => (
                <NavigationRow
                  key={worker.id}
                  title={worker.title ?? worker.id}
                  hint={`${worker.provider} · ${relativeTime(worker.updatedAt, now)}`}
                  trailing={
                    <Text style={styles[STATUS[group.id].tone]}>
                      {STATUS[group.id].label}
                    </Text>
                  }
                  onPress={() => navigation?.openAgent({ agentId: worker.id })}
                  styles={styles}
                  theme={theme}
                />
              ))}
            </SettingsCard>
          </SettingsSection>
        ))
      )}

      <MemorySections conductorId={conductorId} styles={styles} theme={theme} />
    </View>
  );
}
