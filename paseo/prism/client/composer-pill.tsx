import type {
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { Pressable, Text, View } from "react-native";

import { breakdownOf, CATEGORIES } from "../shared/classify.js";
import { useAppAppearance } from "./appearance.js";
import { useRepoStatus } from "./data.js";
import { DEFAULT_COMPARE, statusRpc } from "../shared/contracts.js";
import { openPrismPanel } from "./store.js";
import { formatCompact } from "./web.js";
import { typographyFor } from "./styling.js";

/** What the change set is made of: code, tests, mocks, lockfiles and so on, with totals. */
function BreakdownContent({ theme, layout, workspaceId, close }: PluginButtonContentProps) {
  const typo = typographyFor(useAppAppearance(), layout.compact);
  const status = useRepoStatus(workspaceId);
  const files = status.data?.files;
  const rows = files ? breakdownOf(files) : [];
  const totals = rows.reduce(
    (sum, row) => ({ additions: sum.additions + row.additions, deletions: sum.deletions + row.deletions, files: sum.files + row.files }),
    { additions: 0, deletions: 0, files: 0 },
  );
  const number = { fontSize: typo.ui, fontVariant: ["tabular-nums" as const], minWidth: 52, textAlign: "right" as const };
  const open = (id: "changes" | "diff") => {
    // The Explorer side panel does not exist in the compact layout, so panels open as workspace tabs there.
    openPrismPanel(workspaceId, id, id === "diff" || layout.compact ? "workspace" : "explorer");
    close();
  };
  return (
    <View style={{ gap: 8, minWidth: 240 }}>
      {status.isPending ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: typo.ui }}>Loading changes…</Text>
      ) : rows.length === 0 ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: typo.ui }}>No changes</Text>
      ) : (
        <>
          {rows.map((row) => (
            <View key={row.category} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Icon name={CATEGORIES[row.category].icon} size={14} color={theme.colors.foregroundMuted} />
              <Text style={{ flex: 1, color: theme.colors.foreground, fontSize: typo.ui }}>
                {CATEGORIES[row.category].label}
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: typo.small }}>{`  ${row.files}`}</Text>
              </Text>
              <Text style={[number, { color: theme.colors.statusSuccess }]}>{`+${row.additions}`}</Text>
              <Text style={[number, { color: theme.colors.statusDanger }]}>{`−${row.deletions}`}</Text>
            </View>
          ))}
          <View style={{ height: 1, backgroundColor: theme.colors.border }} />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ flex: 1, color: theme.colors.foreground, fontSize: typo.ui, fontWeight: "600" }}>
              {`Total · ${totals.files} ${totals.files === 1 ? "file" : "files"}`}
            </Text>
            <Text style={[number, { color: theme.colors.statusSuccess }]}>{`+${totals.additions}`}</Text>
            <Text style={[number, { color: theme.colors.statusDanger }]}>{`−${totals.deletions}`}</Text>
          </View>
        </>
      )}
      <View style={{ flexDirection: "row", gap: 16, paddingTop: 4 }}>
        {(["changes", "diff"] as const).map((id) => (
          <Pressable key={id} accessibilityRole="button" onPress={() => open(id)} style={{ paddingVertical: layout.compact ? 8 : 2 }}>
            <Text style={{ color: theme.colors.accent, fontSize: typo.ui }}>{id === "diff" ? "Open diffs" : "Open changes"}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

type Totals = { additions: number; deletions: number };

function hasChanges(stat: Totals | null | undefined): stat is Totals {
  return Boolean(stat && (stat.additions > 0 || stat.deletions > 0));
}

function totalsLabel(stat: Totals): string {
  return `+${formatCompact(stat.additions)} −${formatCompact(stat.deletions)}`;
}

const REFRESH_DELAY_MS = 600;

/** Adds a Changes pill to every agent's composer; its label tracks the workspace's uncommitted totals. */
export function contributeComposerPills(client: PluginClientContext): () => void {
  const pills = new Map<string, PluginButtonRegistration>();
  const agents = new Map<string, string>();
  const totals = new Map<string, Totals | null>();
  const lifetime = new AbortController();
  let releaseWorkspaces = () => {};

  // The pill exists only while its workspace has uncommitted changes.
  const syncPill = (agentId: string) => {
    const workspaceId = agents.get(agentId);
    const stat = workspaceId === undefined ? null : totals.get(workspaceId);
    const existing = pills.get(agentId);
    if (workspaceId === undefined || !hasChanges(stat) || lifetime.signal.aborted) {
      existing?.remove();
      pills.delete(agentId);
      return;
    }
    const label = totalsLabel(stat);
    if (existing) return existing.update({ label });
    pills.set(
      agentId,
      client.addComposerPill({
        id: "changes",
        workspaceId,
        agentId,
        button: {
          title: "Changes",
          icon: "FileDiff",
          label,
          behavior: { kind: "popover", Content: BreakdownContent },
        },
      }),
    );
  };

  const setTotals = (workspaceId: string, stat: Totals | null) => {
    totals.set(workspaceId, stat);
    for (const [agentId, agentWorkspaceId] of agents) if (agentWorkspaceId === workspaceId) syncPill(agentId);
  };

  // Paseo's own totals span the whole branch, so uncommitted totals come from our status; any workspace
  // update schedules a refresh, and the daemon coalesces the git work.
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const refreshTotals = (workspace: { id: string; workspaceDirectory: string }) => {
    clearTimeout(timers.get(workspace.id));
    timers.set(
      workspace.id,
      setTimeout(() => {
        if (lifetime.signal.aborted || !workspace.workspaceDirectory) return;
        client
          .rpc(statusRpc, { cwd: workspace.workspaceDirectory, compare: DEFAULT_COMPARE })
          .then(({ files }) =>
            setTotals(
              workspace.id,
              files.reduce(
                (sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }),
                { additions: 0, deletions: 0 },
              ),
            ),
          )
          .catch(() => setTotals(workspace.id, null));
      }, REFRESH_DELAY_MS),
    );
  };

  const register = (agent: { id: string; workspaceId?: string | null }) => {
    if (!agent.workspaceId) return;
    agents.set(agent.id, agent.workspaceId);
    syncPill(agent.id);
  };
  const forget = (agentId: string) => {
    agents.delete(agentId);
    syncPill(agentId);
  };
  const removeAll = () => {
    for (const pill of pills.values()) pill.remove();
    pills.clear();
    agents.clear();
  };
  const report = (error: unknown) => {
    if (!lifetime.signal.aborted) console.error("[prism] observation failed", error);
  };

  void client.paseo.workspaces
    .list({ subscribe: {} })
    .then(({ subscription }) => {
      releaseWorkspaces = () => void subscription.release();
      subscription.subscribe({
        snapshot: ({ entries }) => {
          for (const workspace of entries) refreshTotals(workspace);
        },
        update: (message) => {
          if (message.type !== "workspace_update" || message.payload.kind !== "upsert") return;
          refreshTotals(message.payload.workspace);
        },
      });
      return undefined;
    })
    .catch(report);

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          removeAll();
          for (const { agent } of entries) register(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") return register(update.agent);
          forget(update.agentId);
        },
      });
      return undefined;
    })
    .catch(report);

  return () => {
    lifetime.abort();
    timers.forEach((timer) => clearTimeout(timer));
    releaseWorkspaces();
    removeAll();
  };
}
