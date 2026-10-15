import { usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { createConductorRpc } from "../shared/contracts.js";
import {
  DEFAULT_TICKET_PREFIX,
  displayTicketId,
  ticketPrefixSchema,
} from "../shared/progress.js";
import { conductorSettings } from "../shared/settings.js";
import {
  type ConductorSelection,
  modelOptions,
  providerOptions,
  resolveSelection,
  selectableProviders,
  thinkingOptions,
} from "./provider-options.js";
import { errorMessage } from "./errors.js";

export function NewConductorForm({
  initialWorkspaceId,
  onCreated,
}: {
  initialWorkspaceId: string | undefined;
  onCreated(agentId: string): void;
}) {
  const paseo = usePaseo();
  const toast = useToast();
  const settings = useSettings(conductorSettings);
  const createConductor = useRpc(createConductorRpc);
  const saved = settings.status === "ready" ? settings.values : null;

  const projects = useQuery({
    queryKey: ["conductor", "projects"],
    queryFn: async () => (await paseo.projects.list()).projects,
  });
  // Only used to translate "start in this workspace" into that workspace's project.
  const workspaces = useQuery({
    queryKey: ["conductor", "workspaces"],
    queryFn: async () => (await paseo.workspaces.list()).entries,
    enabled: Boolean(initialWorkspaceId),
  });
  const snapshot = useQuery({
    queryKey: ["conductor", "providers"],
    queryFn: async () => (await paseo.providers.snapshot()).entries,
    refetchInterval: (query) =>
      query.state.data?.some((entry) => entry.status === "loading")
        ? 2_000
        : false,
  });
  const providers = useMemo(
    () => selectableProviders(snapshot.data ?? []),
    [snapshot.data],
  );

  const [draft, setDraft] = useState<
    Partial<ConductorSelection & { projectId: string; newWorktree: boolean }>
  >({});
  const [branch, setBranch] = useState("");
  const [title, setTitle] = useState("Conductor");
  const [prompt, setPrompt] = useState("");
  const [prefixDraft, setPrefixDraft] = useState("");
  const prefix = ticketPrefixSchema.safeParse(
    prefixDraft.trim() || DEFAULT_TICKET_PREFIX,
  );

  const projectIds = (projects.data ?? []).map((project) => project.projectId);
  const initialProjectId = workspaces.data?.find(
    (workspace) => workspace.id === initialWorkspaceId,
  )?.projectId;
  const projectId =
    [draft.projectId, initialProjectId, saved?.lastProjectId].find(
      (id) => id && projectIds.includes(id),
    ) ??
    projectIds[0] ??
    "";
  const newWorktree = draft.newWorktree ?? saved?.lastNewWorktree ?? false;
  const selection = resolveSelection(providers, {
    provider: draft.provider ?? saved?.lastProvider ?? "",
    model: draft.model ?? saved?.lastModel ?? "",
    thinkingOptionId:
      draft.thinkingOptionId ?? saved?.lastThinkingOptionId ?? "",
  });
  const selectedProvider = providers.find(
    (provider) => provider.id === selection?.provider,
  );

  /** Persists every choice immediately so the next conductor starts from it. */
  function choose(
    change: Partial<
      ConductorSelection & { projectId: string; newWorktree: boolean }
    >,
  ): void {
    const next = { ...draft, ...change };
    if (change.provider)
      Object.assign(next, { model: "", thinkingOptionId: "" });
    if (change.model !== undefined && !change.provider)
      next.thinkingOptionId = "";
    const resolved = resolveSelection(providers, {
      provider: next.provider ?? selection?.provider ?? "",
      model: next.model ?? selection?.model ?? "",
      thinkingOptionId:
        next.thinkingOptionId ?? selection?.thinkingOptionId ?? "",
    });
    const nextProjectId = next.projectId ?? projectId;
    const nextNewWorktree = next.newWorktree ?? newWorktree;
    setDraft({
      ...resolved,
      projectId: nextProjectId,
      newWorktree: nextNewWorktree,
    });
    if (settings.status !== "ready" || !resolved) return;
    void settings
      .save(
        {
          ...settings.values,
          lastProvider: resolved.provider,
          lastModel: resolved.model,
          lastThinkingOptionId: resolved.thinkingOptionId,
          lastProjectId: nextProjectId,
          lastNewWorktree: nextNewWorktree,
        },
        settings.revision,
      )
      .catch((error: unknown) => toast.error(errorMessage(error)));
  }

  const create = useMutation({
    mutationFn: async () => {
      if (!selection) throw new Error("No provider is ready");
      return createConductor({
        projectId,
        newWorktree,
        ...(newWorktree && branch.trim() ? { branch: branch.trim() } : {}),
        provider: selection.provider,
        ...(selection.model ? { model: selection.model } : {}),
        ...(selection.thinkingOptionId
          ? { thinkingOptionId: selection.thinkingOptionId }
          : {}),
        title: title.trim() || "Conductor",
        prompt: prompt.trim() || undefined,
        ...(prefix.success && prefix.data !== DEFAULT_TICKET_PREFIX
          ? { ticketPrefix: prefix.data }
          : {}),
      });
    },
    onSuccess: ({ agentId }) => {
      toast.show("Conductor started", { variant: "success" });
      onCreated(agentId);
    },
  });

  const levels = thinkingOptions(selectedProvider, selection?.model ?? "");
  const canCreate =
    Boolean(projectId && selection && prefix.success) && !create.isPending;

  return (
    <SettingsSection
      title="New conductor"
      info="Starts a long-lived coordinator that delegates work to worker agents. Choices are remembered for next time"
    >
      <SettingsCard>
        <SettingsSelect
          label="Project"
          hint="Always starts in a new workspace. Workers may still use their own worktrees."
          error={projects.error?.message ?? null}
          value={projectId}
          options={(projects.data ?? []).map((project) => ({
            label: project.projectDisplayName,
            value: project.projectId,
          }))}
          onValueChange={(value) => choose({ projectId: value })}
          disabled={!projects.data?.length}
        />
        <SettingsSwitch
          label="New worktree"
          hint={
            newWorktree
              ? "Cuts a fresh worktree for the conductor"
              : "Uses the project's main checkout"
          }
          value={newWorktree}
          onValueChange={(value) => choose({ newWorktree: value })}
        />
        {newWorktree ? (
          <SettingsInput
            label="Branch"
            hint="Base branch for the worktree. Empty uses the project's default."
            initialValue={branch}
            onChangeText={setBranch}
            placeholder="main"
          />
        ) : null}
        <SettingsSelect
          label="Provider"
          hint={snapshot.isPending ? "Loading providers…" : undefined}
          error={snapshot.error?.message ?? null}
          value={selection?.provider ?? ""}
          options={providerOptions(providers)}
          onValueChange={(value) => choose({ provider: value })}
          disabled={providers.length === 0}
        />
        <SettingsSelect
          label="Model"
          value={selection?.model ?? ""}
          options={modelOptions(selectedProvider)}
          onValueChange={(value) => choose({ model: value })}
          disabled={!selectedProvider?.models.length}
        />
        {levels.length > 0 ? (
          <SettingsSelect
            label="Reasoning"
            value={selection?.thinkingOptionId ?? ""}
            options={levels}
            onValueChange={(value) => choose({ thinkingOptionId: value })}
          />
        ) : null}
        <SettingsInput
          label="Title"
          initialValue={title}
          onChangeText={setTitle}
        />
        <SettingsInput
          label="Ticket prefix"
          hint={
            prefix.success
              ? `Optional, 1-3 letters or digits. Tickets read ${displayTicketId("T01", prefix.data)}.`
              : undefined
          }
          error={
            prefix.success ? null : (prefix.error.issues[0]?.message ?? null)
          }
          initialValue=""
          onChangeText={setPrefixDraft}
          placeholder={DEFAULT_TICKET_PREFIX}
        />
        <SettingsInput
          label="First message"
          hint="Optional. Defaults to a short readiness check."
          initialValue=""
          onChangeText={setPrompt}
        />
        <SettingsAction
          label="Start conductor"
          hint={create.error ? undefined : "Opens the conversation when ready"}
          error={create.error ? errorMessage(create.error) : null}
          actionLabel={create.isPending ? "Starting..." : "Start"}
          onPress={() => create.mutate()}
          disabled={!canCreate}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
