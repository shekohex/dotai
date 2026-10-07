import type { PluginTheme } from "@getpaseo/plugin";
import { SettingsCard, SettingsSection } from "@getpaseo/plugin/client/ui";
import type { ReactNode } from "react";
import { Text } from "react-native";

import { AddMemoryFileRow, DocumentRow, useDocuments } from "./documents.js";
import { EmptyRow } from "./rows.js";
import type { Styles } from "./styles.js";
import { errorMessage } from "./errors.js";

/** Conductor memory (when a conductor is given), global memory, and the project's CONDUCTOR.md. */
export function MemorySections({
  conductorId,
  workspaceId,
  workspacePicker,
  styles,
  theme,
}: {
  conductorId?: string;
  workspaceId?: string;
  /** Card row rendered above CONDUCTOR.md, e.g. a workspace select. */
  workspacePicker?: ReactNode;
  styles: Styles;
  theme: PluginTheme;
}) {
  const documents = useDocuments({
    ...(conductorId ? { conductorId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  });
  const data = documents.data;
  const status = documents.error ? (
    <Text style={[styles.rowError, styles.row]}>
      {errorMessage(documents.error)}
    </Text>
  ) : (
    <EmptyRow label="Loading..." styles={styles} />
  );

  return (
    <>
      {conductorId ? (
        <SettingsSection
          title="Conductor memory"
          info="Private to this conductor. It reads instructions.md and notes.md when a conversation starts, and is told to re-read instructions.md when you save it here"
        >
          <SettingsCard>
            {data
              ? data.conductor.map((document) => (
                  <DocumentRow
                    key={document.path}
                    document={document}
                    notifyConductorId={
                      document.name === "instructions.md"
                        ? conductorId
                        : undefined
                    }
                    styles={styles}
                    theme={theme}
                  />
                ))
              : status}
            {data ? (
              <AddMemoryFileRow
                target={{ scope: "conductor", conductorId }}
                existingNames={data.conductor.map((document) => document.name)}
                styles={styles}
              />
            ) : null}
          </SettingsCard>
        </SettingsSection>
      ) : null}

      <SettingsSection
        title="Global memory"
        info="Shared by all conductors. MEMORY.md is the index; conductors save your explicit preferences here"
      >
        <SettingsCard>
          {data
            ? data.global.map((document) => (
                <DocumentRow
                  key={document.path}
                  document={document}
                  styles={styles}
                  theme={theme}
                />
              ))
            : status}
          {data ? (
            <AddMemoryFileRow
              target={{ scope: "global" }}
              existingNames={data.global.map((document) => document.name)}
              styles={styles}
            />
          ) : null}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Project instructions"
        info="CONDUCTOR.md works like AGENTS.md for conductors. New conductors get it in their system instructions; a conductor re-reads it when you save it from its page"
      >
        <SettingsCard>
          {workspacePicker}
          {data?.project ? (
            <DocumentRow
              key={data.project.path}
              document={data.project}
              notifyConductorId={conductorId}
              styles={styles}
              theme={theme}
            />
          ) : data ? (
            <EmptyRow label="Select a workspace" styles={styles} />
          ) : (
            status
          )}
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
