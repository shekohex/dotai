import { useMutation, useQuery } from "@tanstack/react-query";
import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useMemo } from "react";
import { Linking, Pressable, ScrollView, Text, View } from "react-native";

import {
  destroyWorkRpc,
  initConfigRpc,
  listWorkRpc,
  pauseWorkRpc,
  resumeWorkRpc,
} from "../shared/contracts.js";
import {
  idleLabel,
  primaryLifecycleAction,
  type WorkSummaryView,
} from "./work-view-model.js";

type WorkAction = { kind: "pause" | "resume" | "destroy"; workId: string };

export function WorkSandboxes({ theme, layout }: PluginSurfaceProps) {
  const listWork = useRpc(listWorkRpc);
  const initializeConfig = useRpc(initConfigRpc);
  const pauseWork = useRpc(pauseWorkRpc);
  const resumeWork = useRpc(resumeWorkRpc);
  const destroyWork = useRpc(destroyWorkRpc);
  const toast = useToast();
  const query = useQuery({
    queryKey: ["cubesandbox", "work"],
    queryFn: () => listWork({}),
    refetchInterval: 5_000,
  });
  const action = useMutation({
    mutationFn: async (input: WorkAction) => {
      if (input.kind === "pause") return pauseWork({ workId: input.workId });
      if (input.kind === "resume") return resumeWork({ workId: input.workId });
      return destroyWork({ workId: input.workId });
    },
    onMutate: (input) =>
      toast.show(
        input.kind === "destroy"
          ? "Destroying Work Sandbox…"
          : `${input.kind === "pause" ? "Pausing" : "Resuming"} Work Sandbox…`,
        { variant: "info" },
      ),
    onSuccess: async (_result, input) => {
      toast.show(
        input.kind === "destroy"
          ? "Work Sandbox destroyed"
          : `Work Sandbox ${input.kind}d`,
        {
          variant: "success",
        },
      );
      await query.refetch();
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : String(error)),
  });
  const initialize = useMutation({
    mutationFn: () => initializeConfig({}),
    onMutate: () =>
      toast.show("Initializing CubeSandbox configuration…", {
        variant: "info",
      }),
    onSuccess: ({ path }) =>
      toast.show(`Created ${path}`, { variant: "success" }),
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : String(error)),
  });
  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        backgroundColor: theme.colors.surface0,
      },
      content: {
        padding: layout.compact ? 16 : 24,
        gap: layout.compact ? 12 : 16,
      },
      heading: {
        color: theme.colors.foreground,
        fontSize: layout.compact ? 20 : 24,
        fontWeight: "700" as const,
      },
      muted: { color: theme.colors.foregroundMuted },
      error: { color: theme.colors.statusDanger },
      card: {
        gap: 10,
        padding: layout.compact ? 14 : 18,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 12,
        backgroundColor: theme.colors.surface1,
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
        paddingHorizontal: 12,
        paddingVertical: 9,
        borderRadius: 9,
        backgroundColor: theme.colors.accent,
      },
      buttonText: {
        color: theme.colors.foreground,
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
    }),
    [layout.compact, theme],
  );

  if (query.isPending) {
    return (
      <View style={[styles.screen, styles.content]}>
        <Text style={styles.muted}>Loading Work Sandboxes…</Text>
      </View>
    );
  }
  if (query.error) {
    return (
      <View style={[styles.screen, styles.content]}>
        <Text style={styles.error}>{query.error.message}</Text>
      </View>
    );
  }
  const works = query.data?.works ?? [];
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
      {works.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.project}>
            Initialize CubeSandbox configuration
          </Text>
          <Text style={styles.muted}>
            Creates only .cube/config.json. Dockerfile and sandbox.py stay
            project-owned.
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={!query.data?.canInitialize || initialize.isPending}
            onPress={() => initialize.mutate()}
            style={styles.primaryButton}
          >
            <Text style={styles.primaryButtonText}>
              {initialize.isPending
                ? "Initializing…"
                : "Initialize configuration"}
            </Text>
          </Pressable>
          {!query.data?.canInitialize ? (
            <Text style={styles.muted}>
              Open one project agent first, then return here.
            </Text>
          ) : null}
        </View>
      ) : (
        works.map((work) => (
          <WorkCard
            key={work.workId}
            work={work}
            busy={action.isPending && action.variables?.workId === work.workId}
            onAction={(kind) => action.mutate({ kind, workId: work.workId })}
            styles={styles}
            theme={theme}
          />
        ))
      )}
    </ScrollView>
  );
}

function WorkCard({
  work,
  busy,
  onAction,
  styles,
  theme,
}: {
  work: WorkSummaryView;
  busy: boolean;
  onAction(kind: WorkAction["kind"]): void;
  styles: Record<string, object>;
  theme: PluginSurfaceProps["theme"];
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
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <View style={styles.grow}>
          <Text style={styles.project}>{work.projectId}</Text>
          <Text style={styles.muted}>{work.repository}</Text>
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
            disabled={busy}
            onPress={() => onAction(lifecycleAction)}
            style={styles.button}
          >
            <Text style={styles.buttonText}>
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
          disabled={busy}
          onPress={() => onAction("destroy")}
          style={styles.button}
        >
          <Text style={styles.dangerText}>Destroy now</Text>
        </Pressable>
      </View>
      <Text
        style={[styles.muted, { color: theme.colors.foregroundMuted }]}
        selectable
      >
        {work.workId}
      </Text>
    </View>
  );
}
