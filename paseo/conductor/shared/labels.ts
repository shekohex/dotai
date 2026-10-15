export const CONDUCTOR_ROLE_LABEL = "conductor.role";
export const CONDUCTOR_ROLE = "coordinator";
/** Paseo stores the subagent relationship under this label. */
export const PARENT_AGENT_LABEL = "paseo.parent-agent-id";

export const conductorLabels = { [CONDUCTOR_ROLE_LABEL]: CONDUCTOR_ROLE };

export function isConductor(labels: Readonly<Record<string, string>>): boolean {
  return labels[CONDUCTOR_ROLE_LABEL] === CONDUCTOR_ROLE;
}

/** Max parent hops when looking for an agent's conductor; matches the server's walk. */
export const MAX_PARENT_HOPS = 6;

/** The conductor an agent works for (itself or the nearest conductor ancestor), from known labels. */
export function findConductorId(
  agentId: string,
  labelsOf: (id: string) => Readonly<Record<string, string>> | undefined,
): string | null {
  let current = agentId;
  for (let hop = 0; hop < MAX_PARENT_HOPS; hop += 1) {
    const labels = labelsOf(current);
    if (!labels) return null;
    if (isConductor(labels)) return current;
    const parent = labels[PARENT_AGENT_LABEL];
    if (!parent) return null;
    current = parent;
  }
  return null;
}

/**
 * Conductors with work in a workspace: conductors in it and the conductors of agents in it,
 * most recently active first.
 */
export function workspaceConductorIds(
  agents: readonly {
    id: string;
    workspaceId?: string | null;
    labels?: Readonly<Record<string, string>>;
    lastActivityAt?: string;
  }[],
  workspaceId: string,
): string[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const activity = new Map<string, string>();
  for (const agent of agents) {
    if (agent.workspaceId !== workspaceId) continue;
    const conductorId = findConductorId(
      agent.id,
      (id) => byId.get(id)?.labels ?? (byId.has(id) ? {} : undefined),
    );
    if (!conductorId) continue;
    const at = agent.lastActivityAt ?? "";
    if ((activity.get(conductorId) ?? "") <= at) activity.set(conductorId, at);
  }
  return [...activity.entries()]
    .sort(([, a], [, b]) => b.localeCompare(a))
    .map(([id]) => id);
}
