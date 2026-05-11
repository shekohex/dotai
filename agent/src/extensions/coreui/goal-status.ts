import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Theme = ExtensionContext["ui"]["theme"];

function styleGoalStatus(theme: Theme, goalStatus: string): string {
  if (goalStatus.startsWith("Goal achieved")) {
    return theme.bold(theme.fg("success", goalStatus));
  }

  if (goalStatus.startsWith("Goal paused")) {
    return theme.italic(theme.fg("warning", goalStatus));
  }

  if (goalStatus.startsWith("Goal unmet") || goalStatus.startsWith("Goal abandoned")) {
    return theme.italic(theme.fg("warning", goalStatus));
  }

  if (goalStatus.startsWith("Pursuing goal")) {
    return theme.italic(theme.fg("accent", goalStatus));
  }

  return theme.italic(theme.fg("muted", goalStatus));
}

export function appendGoalRuntimeStatus(
  theme: Theme,
  runtimeStatus: string,
  goalStatus: string | undefined,
): string {
  if (goalStatus === undefined || goalStatus.length === 0) {
    return runtimeStatus;
  }

  if (runtimeStatus.length === 0) {
    return styleGoalStatus(theme, goalStatus);
  }

  return `${runtimeStatus}${theme.fg("dim", " · ")}${styleGoalStatus(theme, goalStatus)}`;
}
