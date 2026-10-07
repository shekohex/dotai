import { usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { createConductorRpc } from "../shared/contracts.js";
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

  const workspaces = useQuery({
    queryKey: ["conductor", "workspaces"],
    queryFn: async () => (await paseo.workspaces.list()).entries,
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
    Partial<ConductorSelection & { workspaceId: string }>
  >({});
  const [title, setTitle] = useState("Conductor");
  const [prompt, setPrompt] = useState("");

  const workspaceIds = (workspaces.data ?? []).map((workspace) => workspace.id);
  const workspaceId =
    [draft.workspaceId, initialWorkspaceId, saved?.lastWorkspaceId].find(
      (id) => id && workspaceIds.includes(id),
    ) ??
    workspaceIds[0] ??
    "";
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
    change: Partial<ConductorSelection & { workspaceId: string }>,
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
    const nextWorkspaceId = next.workspaceId ?? workspaceId;
    setDraft({ ...resolved, workspaceId: nextWorkspaceId });
    if (settings.status !== "ready" || !resolved) return;
    void settings
      .save(
        {
          lastProvider: resolved.provider,
          lastModel: resolved.model,
          lastThinkingOptionId: resolved.thinkingOptionId,
          lastWorkspaceId: nextWorkspaceId,
        },
        settings.revision,
      )
      .catch((error: unknown) => toast.error(errorMessage(error)));
  }

  const create = useMutation({
    mutationFn: async () => {
      if (!selection) throw new Error("No provider is ready");
      return createConductor({
        workspaceId,
        provider: selection.provider,
        ...(selection.model ? { model: selection.model } : {}),
        ...(selection.thinkingOptionId
          ? { thinkingOptionId: selection.thinkingOptionId }
          : {}),
        title: title.trim() || "Conductor",
        prompt: prompt.trim() || undefined,
      });
    },
    onSuccess: ({ agentId }) => {
      toast.show("Conductor started", { variant: "success" });
      onCreated(agentId);
    },
  });

  const levels = thinkingOptions(selectedProvider, selection?.model ?? "");
  const canCreate = Boolean(workspaceId && selection) && !create.isPending;

  return (
    <SettingsSection
      title="New conductor"
      info="Starts a long-lived coordinator that delegates work to worker agents. Choices are remembered for next time"
    >
      <SettingsCard>
        <SettingsSelect
          label="Workspace"
          hint="Where the conductor runs. Workers may still use their own worktrees."
          value={workspaceId}
          options={(workspaces.data ?? []).map((workspace) => ({
            label: `${workspace.projectDisplayName} · ${workspace.name}`,
            value: workspace.id,
          }))}
          onValueChange={(value) => choose({ workspaceId: value })}
          disabled={!workspaces.data?.length}
        />
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
