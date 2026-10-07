export const CONDUCTOR_ROLE_LABEL = "conductor.role";
export const CONDUCTOR_ROLE = "coordinator";
/** Paseo stores the subagent relationship under this label. */
export const PARENT_AGENT_LABEL = "paseo.parent-agent-id";

export const conductorLabels = { [CONDUCTOR_ROLE_LABEL]: CONDUCTOR_ROLE };

export function isConductor(labels: Readonly<Record<string, string>>): boolean {
  return labels[CONDUCTOR_ROLE_LABEL] === CONDUCTOR_ROLE;
}
