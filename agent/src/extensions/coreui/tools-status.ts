export type ToolPhase = "pending" | "success" | "error";

export type ToolVerbs = {
  pending: string;
  success: string;
  error: string;
};

type ToolStatusTheme = {
  fg: (token: "error" | "muted" | "borderAccent" | "borderMuted", value: string) => string;
  bold: (value: string) => string;
  italic: (value: string) => string;
};

type ToolStatusContext = {
  isPartial: boolean;
  isError: boolean;
};

function getToolPhase(context: ToolStatusContext): ToolPhase {
  if (context.isError) {
    return "error";
  }

  if (context.isPartial) {
    return "pending";
  }

  return "success";
}

export function formatToolStatus(
  theme: ToolStatusTheme,
  context: ToolStatusContext,
  verbs: ToolVerbs,
): string {
  const phase = getToolPhase(context);
  if (phase === "error") {
    return theme.bold(theme.fg("error", verbs.error));
  }

  if (phase === "success") {
    return theme.bold(theme.fg("muted", verbs.success));
  }

  return theme.italic(theme.fg("muted", verbs.pending));
}

export function formatToolRail(theme: ToolStatusTheme, context: ToolStatusContext): string {
  if (context.isError) {
    return theme.fg("error", "▏");
  }

  if (context.isPartial) {
    return theme.fg("borderAccent", "▏");
  }

  return theme.fg("borderMuted", "▏");
}

export function formatBashStatus(theme: ToolStatusTheme, context: ToolStatusContext): string {
  const rail = formatToolRail(theme, context);

  if (context.isError) {
    return `${rail}${theme.bold(theme.fg("error", "$"))}`;
  }

  if (context.isPartial) {
    return `${rail}${theme.italic(theme.fg("muted", "$"))}`;
  }

  return `${rail}${theme.bold(theme.fg("muted", "$"))}`;
}
