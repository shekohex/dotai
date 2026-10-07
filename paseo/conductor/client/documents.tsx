import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import {
  Modal,
  TextInput,
  useToast,
} from "@getpaseo/plugin/client/react-native";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
} from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";

import {
  type ConductorDocument,
  type DocumentRef,
  listDocumentsRpc,
  MEMORY_FILE_NAME,
  writeDocumentRpc,
} from "../shared/contracts.js";
import { CollapsibleRow } from "./rows.js";
import type { Styles } from "./styles.js";
import { errorMessage } from "./errors.js";

const PROJECT_TEMPLATE =
  "# Conductor instructions\n\nProject-specific rules for conductors working in this project.\n";

export function useDocuments(input: {
  conductorId?: string;
  workspaceId?: string;
}) {
  const listDocuments = useRpc(listDocumentsRpc);
  return useQuery({
    queryKey: [
      "conductor",
      "documents",
      input.conductorId ?? "",
      input.workspaceId ?? "",
    ],
    queryFn: () => listDocuments(input),
    refetchInterval: 15_000,
  });
}

function useWriteDocument() {
  const writeDocument = useRpc(writeDocumentRpc);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: writeDocument,
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["conductor", "documents"] }),
  });
}

/** One editable file as an expandable card row. Render it as a direct child of SettingsCard. */
export function DocumentRow({
  document,
  notifyConductorId,
  styles,
  theme,
}: {
  document: ConductorDocument;
  /** Conductor told to re-read the file after a save. */
  notifyConductorId?: string | undefined;
  styles: Styles;
  theme: PluginTheme;
}) {
  const toast = useToast();
  const write = useWriteDocument();
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [baseline, setBaseline] = useState(document.content);
  const [draft, setDraft] = useState(document.content ?? PROJECT_TEMPLATE);
  const exists = baseline !== null;
  const dirty = draft !== (baseline ?? PROJECT_TEMPLATE);

  // Follow the file while there are no local edits; the conductor writes these files too.
  useEffect(() => {
    if (dirty) return;
    setBaseline(document.content);
    setDraft(document.content ?? PROJECT_TEMPLATE);
  }, [document.content]);

  function save(content: string | null): void {
    write.mutate(
      {
        ref: document.ref,
        content,
        previousContent: baseline,
        ...(notifyConductorId ? { notifyConductorId } : {}),
      },
      {
        onSuccess: () => {
          setBaseline(content);
          if (content === null) {
            setDraft(PROJECT_TEMPLATE);
            setConfirmDelete(false);
            setOpen(false);
          }
          toast.show(
            content === null
              ? `Deleted ${document.name}`
              : `Saved ${document.name}`,
            {
              variant: "success",
            },
          );
        },
      },
    );
  }

  const hint = exists ? document.path : `Not created yet · ${document.path}`;
  return (
    <CollapsibleRow
      title={document.name}
      hint={hint}
      open={open}
      onToggle={() => setOpen(!open)}
      trailing={dirty ? <Text style={styles.warning}>Unsaved</Text> : null}
      styles={styles}
      theme={theme}
    >
      <View style={styles.editor}>
        <TextInput
          multiline
          value={draft}
          onChangeText={setDraft}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          accessibilityLabel={`${document.name} content`}
          style={styles.editorInput}
        />
        {write.error ? (
          <Text style={styles.rowError}>{errorMessage(write.error)}</Text>
        ) : null}
      </View>
      <View style={styles.rowBorder}>
        <SettingsAction
          label={exists ? "Save changes" : "Create file"}
          hint={dirty || !exists ? undefined : "No changes"}
          actionLabel={
            write.isPending ? "Saving..." : exists ? "Save" : "Create"
          }
          onPress={() => save(draft)}
          disabled={write.isPending || (exists && !dirty)}
        />
      </View>
      {exists && dirty ? (
        <View style={styles.rowBorder}>
          <SettingsAction
            label="Discard changes"
            actionLabel="Discard"
            onPress={() => setDraft(baseline ?? PROJECT_TEMPLATE)}
          />
        </View>
      ) : null}
      {exists && !document.core ? (
        <View style={styles.rowBorder}>
          <SettingsAction
            label="Delete file"
            actionLabel="Delete"
            onPress={() => setConfirmDelete(true)}
            disabled={write.isPending}
          />
        </View>
      ) : null}
      <Modal
        title={`Delete ${document.name}?`}
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
      >
        <Modal.Content>
          <Text style={styles.modalText}>
            This removes {document.path}. It cannot be undone.
          </Text>
          <SettingsCard>
            <SettingsAction
              label="Delete file"
              hint={document.name}
              actionLabel={write.isPending ? "Deleting..." : "Delete"}
              onPress={() => save(null)}
              disabled={write.isPending}
            />
          </SettingsCard>
        </Modal.Content>
      </Modal>
    </CollapsibleRow>
  );
}

/** Card row that opens a sheet to add a memory file. Render as a direct child of SettingsCard. */
export function AddMemoryFileRow({
  target,
  existingNames,
  styles,
}: {
  target: { scope: "global" } | { scope: "conductor"; conductorId: string };
  existingNames: readonly string[];
  styles: Styles;
}) {
  const toast = useToast();
  const write = useWriteDocument();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const fileName = name.trim().endsWith(".md")
    ? name.trim()
    : `${name.trim()}.md`;
  const invalid = !MEMORY_FILE_NAME.test(fileName)
    ? "Use letters, numbers, dots, dashes, or underscores"
    : existingNames.includes(fileName)
      ? `${fileName} already exists`
      : null;

  function create(): void {
    const ref: DocumentRef = { ...target, name: fileName };
    write.mutate(
      {
        ref,
        content: `# ${fileName.replace(/\.md$/, "")}\n\n`,
        previousContent: null,
      },
      {
        onSuccess: () => {
          toast.show(`Created ${fileName}`, { variant: "success" });
          setName("");
          setOpen(false);
        },
      },
    );
  }

  return (
    <>
      <SettingsAction
        label="Add memory file"
        actionLabel="Add"
        onPress={() => setOpen(true)}
      />
      <Modal title="Add memory file" open={open} onOpenChange={setOpen}>
        <Modal.Content>
          <SettingsCard>
            <SettingsInput
              label="File name"
              placeholder="topic.md"
              initialValue=""
              onChangeText={setName}
              error={name.trim() ? invalid : null}
            />
            <SettingsAction
              label="Create file"
              hint={name.trim() && !invalid ? fileName : undefined}
              actionLabel={write.isPending ? "Creating..." : "Create"}
              onPress={create}
              disabled={!name.trim() || invalid !== null || write.isPending}
            />
          </SettingsCard>
          {write.error ? (
            <Text style={styles.rowError}>{errorMessage(write.error)}</Text>
          ) : null}
        </Modal.Content>
      </Modal>
    </>
  );
}
