export const SUBAGENT_TOOL_NAME = "subagent";

let subagentToolEnabled = false;

export function isSubagentToolEnabled(): boolean {
  return subagentToolEnabled;
}

export function setSubagentToolEnabled(enabled: boolean): void {
  subagentToolEnabled = enabled;
}
