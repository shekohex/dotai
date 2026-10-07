export type NoticeReason =
  "is stalled" | "still needs permission" | "was interrupted";

/**
 * Paseo's system envelope: the daemon hides it from the conductor's visible timeline, just like
 * its own notify-on-finish prompts.
 */
export function formatSystemNote(body: string): string {
  return `<paseo-system>\n${body}\n</paseo-system>`;
}

export function formatConductorNotice(input: {
  agentId: string;
  title: string;
  reason: NoticeReason;
  detail: string;
}): string {
  const statusLine = `Agent ${input.agentId} (${input.title}) ${input.reason}.`;
  return formatSystemNote(`${statusLine}\n\n${input.detail}`);
}
