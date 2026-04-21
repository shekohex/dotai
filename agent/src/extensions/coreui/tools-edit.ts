export type DiffStats = {
  additions: number;
  deletions: number;
  changes: number;
};

export function summarizeEditProgress(args: { edits?: unknown }): string {
  const editCount = Array.isArray(args.edits) ? args.edits.length : 0;
  if (editCount === 0) {
    return "waiting for diff";
  }

  return `${editCount} edit${editCount === 1 ? "" : "s"} queued`;
}

export function getDiffText(details: unknown): string {
  if (details === undefined || details === null || typeof details !== "object") {
    return "";
  }

  const diff = (details as { diff?: unknown }).diff;
  return typeof diff === "string" ? diff : "";
}

function summarizeDiff(diff: string): DiffStats {
  let additions = 0;
  let deletions = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      additions++;
      continue;
    }
    if (line.startsWith("-")) {
      deletions++;
    }
  }

  return {
    additions,
    deletions,
    changes: additions + deletions,
  };
}

export function getDiffStats(diff: string): DiffStats | undefined {
  if (diff.length === 0) {
    return undefined;
  }

  return summarizeDiff(diff);
}

export function formatDiffStats(
  theme: {
    fg: (token: "toolDiffAdded" | "toolDiffRemoved", value: string) => string;
  },
  additions: number,
  deletions: number,
): string {
  return `${theme.fg("toolDiffAdded", `+${additions}`)} ${theme.fg("toolDiffRemoved", `-${deletions}`)}`;
}

export function formatOptionalDiffStats(
  theme: {
    fg: (token: "muted" | "toolDiffAdded" | "toolDiffRemoved", value: string) => string;
  },
  stats: DiffStats | undefined,
): string {
  if (!stats || stats.changes === 0) {
    return "";
  }

  return `${theme.fg("muted", " · ")}${formatDiffStats(theme, stats.additions, stats.deletions)}`;
}
