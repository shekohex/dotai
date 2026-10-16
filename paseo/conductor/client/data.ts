import { usePaseo } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import {
  conductorLabels,
  PARENT_AGENT_LABEL,
  workspaceConductorIds,
} from "../shared/labels.js";

type PaseoApi = ReturnType<typeof usePaseo>;
export type AgentSnapshot = Awaited<
  ReturnType<PaseoApi["agents"]["list"]>
>["entries"][number]["agent"];

const REFETCH_MS = 5_000;

async function listActiveAgents(
  paseo: PaseoApi,
  labels: Record<string, string>,
): Promise<AgentSnapshot[]> {
  const result = await paseo.agents.list({
    filter: { labels },
    page: { limit: 200 },
  });
  return result.entries
    .map((entry) => entry.agent)
    .filter((agent) => !agent.archivedAt);
}

/** Refetches conductor queries as soon as Paseo reports agent changes. */
function useAgentUpdates(): void {
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  useEffect(
    () =>
      paseo.agents.subscribe(() => {
        void queryClient.invalidateQueries({ queryKey: ["conductor"] });
      }),
    [paseo, queryClient],
  );
}

export function useConductors() {
  const paseo = usePaseo();
  useAgentUpdates();
  return useQuery({
    queryKey: ["conductor", "conductors"],
    queryFn: () => listActiveAgents(paseo, conductorLabels),
    refetchInterval: REFETCH_MS,
  });
}

export function useWorkers(conductorId: string) {
  const paseo = usePaseo();
  useAgentUpdates();
  return useQuery({
    queryKey: ["conductor", "workers", conductorId],
    queryFn: () =>
      listActiveAgents(paseo, { [PARENT_AGENT_LABEL]: conductorId }),
    refetchInterval: REFETCH_MS,
  });
}

/** Conductors working in a workspace, directly or through workers; most recently active first. */
export function useWorkspaceConductors(workspaceId: string) {
  const paseo = usePaseo();
  useAgentUpdates();
  return useQuery({
    queryKey: ["conductor", "workspace-conductors", workspaceId],
    queryFn: async () =>
      workspaceConductorIds(
        (await paseo.agents.list({ page: { limit: 200 } })).entries
          .map((entry) => entry.agent)
          .filter((agent) => !agent.archivedAt),
        workspaceId,
      ),
    refetchInterval: REFETCH_MS,
  });
}

/**
 * Every agent on the host, for titles and status anywhere. Paseo's useAgent only works inside a
 * workspace panel; the Conductors screen and sidebar are not one, so they read this instead.
 */
export function useAgentDirectory() {
  const paseo = usePaseo();
  useAgentUpdates();
  return useQuery({
    queryKey: ["conductor", "agents"],
    queryFn: async () =>
      (await paseo.agents.list({ page: { limit: 200 } })).entries.map(
        (entry) => entry.agent,
      ),
    refetchInterval: REFETCH_MS,
  });
}

export function useAgentSnapshot(agentId: string): AgentSnapshot | null {
  return (
    useAgentDirectory().data?.find((agent) => agent.id === agentId) ?? null
  );
}
