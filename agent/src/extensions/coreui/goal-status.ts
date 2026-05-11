import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Theme = ExtensionContext["ui"]["theme"];

export function appendGoalRuntimeStatus(
  theme: Theme,
  runtimeStatus: string,
  goalStatus: string | undefined,
): string {
  if (goalStatus === undefined || goalStatus.length === 0) {
    return runtimeStatus;
  }

  if (runtimeStatus.length === 0) {
    return theme.fg("muted", goalStatus);
  }

  return `${runtimeStatus}${theme.fg("dim", " · ")}${theme.fg("muted", goalStatus)}`;
}
