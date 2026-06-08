export const SESSION_QUERY_TOOL_NAME = "session_query";

let sessionQueryToolEnabled = false;

export function isSessionQueryToolEnabled(): boolean {
  return sessionQueryToolEnabled;
}

export function setSessionQueryToolEnabled(enabled: boolean): void {
  sessionQueryToolEnabled = enabled;
}
