import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type PluginSurfaceProps,
  usePaseo,
  useRpc,
  useSettings,
} from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo } from "react";
import { Linking, Pressable, ScrollView, Text, View } from "react-native";

import {
  destroyWorkRpc,
  initConfigRpc,
  listProjectsRpc,
  pauseWorkRpc,
  resumeWorkRpc,
} from "../shared/contracts.js";
import { ALL_PROJECTS_VALUE, cubeSandboxSettings } from "../shared/settings.js";
import {
  canInitializeProject,
  canManageProjectWork,
  idleLabel,
  primaryLifecycleAction,
  projectAvailabilityLabel,
  projectCountsLabel,
  projectIdentityLabel,
  projectReadinessLabel,
  resolveSelectedProjectId,
  visibleProjects,
  type CubeProjectSummaryView,
  type WorkSummaryView,
} from "./work-view-model.js";

type WorkActionKind = "pause" | "resume" | "destroy";

interface WorkActionInput {
  kind: WorkActionKind;
  projectId: string;
  workId: string;
}

export function WorkSandboxes({ theme, layout }: PluginSurfaceProps) {
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  const listProjects = useRpc(listProjectsRpc);
  const initializeConfig = useRpc(initConfigRpc);
  const pauseWork = useRpc(pauseWorkRpc);
  const resumeWork = useRpc(resumeWorkRpc);
  const destroyWork = useRpc(destroyWorkRpc);
  const settings = useSettings(cubeSandboxSettings);
  const toast = useToast();
  const query = useQuery({
    queryKey: ["cubesandbox", "projects"],
    queryFn: () => listProjects({}),
    refetchInterval: 5_000,
  });
  useEffect(() => {
    const invalidateProjects = () => {
      void queryClient.invalidateQueries({
        queryKey: ["cubesandbox", "projects"],
      });
    };
    const unsubscribeProject = paseo.projects.subscribe(invalidateProjects);
    const unsubscribeWorkspace = paseo.workspaces.subscribe(invalidateProjects);
    return () => {
      unsubscribeProject();
      unsubscribeWorkspace();
    };
  }, [paseo, queryClient]);

  const projects = query.data?.projects ?? [];
  const selectedProjectId =
    settings.status === "ready" ? settings.values.selectedProjectId : null;
  const effectiveSelectedProjectId = resolveSelectedProjectId(
    projects,
    selectedProjectId,
  );
  const shownProjects = visibleProjects(projects, selectedProjectId);
  const selectOptions = [
    { label: "All projects", value: ALL_PROJECTS_VALUE },
    ...projects.map((project) => ({
      label: project.displayName,
      value: project.projectId,
    })),
  ];

  const action = useMutation({
    mutationFn: async (input: WorkActionInput) => {
      if (input.kind === "pause") {
        return pauseWork({ projectId: input.projectId, workId: input.workId });
      }
      if (input.kind === "resume") {
        return resumeWork({ projectId: input.projectId, workId: input.workId });
      }
      return destroyWork({ projectId: input.projectId, workId: input.workId });
    },
    onMutate: (input) =>
      toast.show(
        input.kind === "destroy"
          ? "Destroying Work Sandbox…"
          : `${input.kind === "pause" ? "Pausing" : "Resuming"} Work Sandbox…`,
        { variant: "info" },
      ),
    onSuccess: (_result, input) =>
      toast.show(
        input.kind === "destroy"
          ? "Work Sandbox destroyed"
          : `Work Sandbox ${input.kind}d`,
        { variant: "success" },
      ),
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : String(error)),
    onSettled: () => query.refetch(),
  });
  const initialize = useMutation({
    mutationFn: (projectId: string) => initializeConfig({ projectId }),
    onMutate: () =>
      toast.show("Initializing CubeSandbox configuration…", {
        variant: "info",
      }),
    onSuccess: ({ path }) =>
      toast.show(`Created ${path}`, { variant: "success" }),
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : String(error)),
    onSettled: () => query.refetch(),
  });

  const styles = useMemo(
    () => createStyles(theme, layout.compact),
    [theme, layout.compact],
  );

  function handleSelect(value: string): void {
    if (settings.status !== "ready") return;
    void settings.save(
      { selectedProjectId: value === ALL_PROJECTS_VALUE ? null : value },
      settings.revision,
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.row}>
        <Icon
          name="Box"
          size={layout.compact ? 20 : 24}
          color={theme.colors.foreground}
        />
        <Text style={styles.heading}>Cube Sandboxes</Text>
      </View>

      <SettingsSelect
        label="Project"
        hint="Each registered Paseo project root is an independent Cube scope."
        value={effectiveSelectedProjectId ?? ALL_PROJECTS_VALUE}
        options={selectOptions}
        onValueChange={handleSelect}
        disabled={settings.status !== "ready" || projects.length === 0}
      />
      {settings.status === "invalid" ? (
        <Text style={styles.error}>{settings.error}</Text>
      ) : null}

      {query.isPending ? (
        <Text style={styles.muted}>Loading Cube Sandboxes…</Text>
      ) : query.error ? (
        <View style={styles.empty}>
          <Text style={styles.error}>{query.error.message}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => void query.refetch()}
            style={styles.button}
          >
            <Text style={styles.buttonText}>Retry</Text>
          </Pressable>
        </View>
      ) : projects.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.project}>No registered Paseo projects</Text>
          <Text style={styles.muted}>
            Open or create a project in Paseo, then return to this surface.
          </Text>
        </View>
      ) : (
        shownProjects.map((project) => (
          <ProjectSection
            key={project.projectId}
            project={project}
            actionPendingId={action.variables?.workId}
            actionPending={action.isPending}
            initializePending={
              initialize.isPending && initialize.variables === project.projectId
            }
            onInitialize={() => initialize.mutate(project.projectId)}
            onWorkAction={(kind, workId) =>
              action.mutate({ kind, projectId: project.projectId, workId })
            }
            styles={styles}
          />
        ))
      )}
    </ScrollView>
  );
}

function ProjectSection({
  project,
  actionPending,
  actionPendingId,
  initializePending,
  onInitialize,
  onWorkAction,
  styles,
}: {
  project: CubeProjectSummaryView;
  actionPending: boolean;
  actionPendingId: string | undefined;
  initializePending: boolean;
  onInitialize(): void;
  onWorkAction(kind: WorkActionKind, workId: string): void;
  styles: ReturnType<typeof createStyles>;
}) {
  const availability = projectAvailabilityLabel(project);
  const manageable = canManageProjectWork(project);
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <View style={styles.grow}>
          <Text style={styles.project}>{project.displayName}</Text>
          <Text style={styles.muted}>{projectIdentityLabel(project)}</Text>
        </View>
        <Text style={availability ? styles.error : styles.status}>
          {availability ?? projectReadinessLabel(project)}
        </Text>
      </View>
      <Text style={styles.muted}>{projectCountsLabel(project)}</Text>
      {project.configError ? (
        <Text style={styles.error} selectable>
          {project.configError}
        </Text>
      ) : null}
      {canInitializeProject(project) ? (
        <>
          <Text style={styles.muted}>
            Creates only .cube/config.json. Dockerfile and sandbox.py stay
            project-owned.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: initializePending }}
            disabled={initializePending}
            onPress={onInitialize}
            style={[
              styles.primaryButton,
              initializePending && styles.buttonDisabled,
            ]}
          >
            <Text
              style={
                initializePending
                  ? styles.buttonTextDisabled
                  : styles.primaryButtonText
              }
            >
              {initializePending ? "Initializing…" : "Initialize configuration"}
            </Text>
          </Pressable>
        </>
      ) : null}
      {project.configStatus === "ready" && project.works.length === 0 ? (
        <Text style={styles.muted}>
          Configuration ready. Create Work Sandbox from an agent.
        </Text>
      ) : null}
      {project.works.map((work) => (
        <WorkCard
          key={work.workId}
          work={work}
          manageable={manageable}
          busy={actionPending && actionPendingId === work.workId}
          onAction={(kind) => onWorkAction(kind, work.workId)}
          styles={styles}
        />
      ))}
    </View>
  );
}

function WorkCard({
  work,
  manageable,
  busy,
  onAction,
  styles,
}: {
  work: WorkSummaryView;
  manageable: boolean;
  busy: boolean;
  onAction(kind: WorkActionKind): void;
  styles: ReturnType<typeof createStyles>;
}) {
  const toast = useToast();
  const lifecycleAction = primaryLifecycleAction(work.status);
  async function openPairing(): Promise<void> {
    if (!work.pairingUrl) return;
    try {
      await Linking.openURL(work.pairingUrl);
      toast.show("Pairing opened", { variant: "success" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }
  const lifecycleDisabled = !manageable || busy;
  return (
    <View style={styles.workCard}>
      <View style={styles.row}>
        <View style={styles.grow}>
          <Text style={styles.project}>{work.repository}</Text>
          <Text style={styles.muted} selectable>
            {work.workId}
          </Text>
        </View>
        <Text style={styles.status}>{work.status}</Text>
      </View>
      <Text style={styles.muted}>
        {work.worktreeCount} worktree · {work.agentCount} agent ·{" "}
        {idleLabel(work)}
      </Text>
      {work.lastError ? (
        <Text style={styles.error}>{work.lastError}</Text>
      ) : null}
      {work.previewUrls.length ? (
        <View style={styles.row}>
          {work.previewUrls.map((url) => (
            <Pressable
              key={url}
              accessibilityRole="link"
              onPress={() =>
                void Linking.openURL(url).catch((error: unknown) =>
                  toast.error(String(error)),
                )
              }
            >
              <Text style={styles.status}>Open preview</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <View style={styles.row}>
        {work.pairingUrl ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => void openPairing()}
            style={styles.primaryButton}
          >
            <Text style={styles.primaryButtonText}>Pair / open agent</Text>
          </Pressable>
        ) : null}
        {lifecycleAction ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: lifecycleDisabled }}
            disabled={lifecycleDisabled}
            onPress={() => onAction(lifecycleAction)}
            style={[styles.button, lifecycleDisabled && styles.buttonDisabled]}
          >
            <Text
              style={
                lifecycleDisabled
                  ? styles.buttonTextDisabled
                  : styles.buttonText
              }
            >
              {busy
                ? "Working…"
                : lifecycleAction === "pause"
                  ? "Pause"
                  : "Resume"}
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={() => onAction("destroy")}
          style={[styles.button, busy && styles.buttonDisabled]}
        >
          <Text style={busy ? styles.buttonTextDisabled : styles.dangerText}>
            Destroy now
          </Text>
        </Pressable>
      </View>
      {!manageable ? (
        <Text style={styles.muted}>
          Project is no longer available. Cleanup actions remain enabled.
        </Text>
      ) : null}
    </View>
  );
}

function createStyles(theme: PluginSurfaceProps["theme"], compact: boolean) {
  return {
    screen: {
      flex: 1,
      backgroundColor: theme.colors.surface0,
    },
    content: {
      width: "100%" as const,
      maxWidth: 880,
      alignSelf: "center" as const,
      padding: compact ? 16 : 24,
      gap: compact ? 12 : 16,
    },
    heading: {
      color: theme.colors.foreground,
      fontSize: compact ? 20 : 24,
      fontWeight: "700" as const,
    },
    muted: { color: theme.colors.foregroundMuted },
    error: { color: theme.colors.statusDanger },
    card: {
      gap: 10,
      padding: compact ? 14 : 18,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 12,
      backgroundColor: theme.colors.surface1,
    },
    workCard: {
      gap: 8,
      padding: compact ? 12 : 14,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 10,
      backgroundColor: theme.colors.surface0,
    },
    row: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      flexWrap: "wrap" as const,
      gap: 8,
    },
    grow: { flexGrow: 1, flexShrink: 1 },
    project: {
      color: theme.colors.foreground,
      fontWeight: "600" as const,
      fontSize: 16,
    },
    status: {
      color: theme.colors.accent,
      textTransform: "capitalize" as const,
    },
    button: {
      paddingHorizontal: 12,
      paddingVertical: 9,
      borderRadius: 9,
      backgroundColor: theme.colors.surface2,
    },
    primaryButton: {
      alignSelf: "flex-start" as const,
      paddingHorizontal: 12,
      paddingVertical: 9,
      borderRadius: 9,
      backgroundColor: theme.colors.accent,
    },
    buttonDisabled: {
      backgroundColor: theme.colors.surface1,
      borderWidth: 1,
      borderColor: theme.colors.border,
      opacity: 0.6,
    },
    buttonText: {
      color: theme.colors.foreground,
      fontWeight: "600" as const,
    },
    buttonTextDisabled: {
      color: theme.colors.foregroundMuted,
      fontWeight: "600" as const,
    },
    primaryButtonText: {
      color: theme.colors.accentForeground,
      fontWeight: "600" as const,
    },
    dangerText: {
      color: theme.colors.statusDanger,
      fontWeight: "600" as const,
    },
    empty: {
      gap: 12,
      padding: 24,
      alignItems: "center" as const,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 12,
      backgroundColor: theme.colors.surface1,
    },
  };
}
