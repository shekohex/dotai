import { createRequire } from "node:module";
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { GsdCommandArgs } from "../args.js";
import { resolvePlanningDir } from "../shared.js";

const require = createRequire(import.meta.url);
const intelModule: unknown = require("../../../resources/gsd/bin/lib/intel.cjs");

type IntelDisabledResponse = { disabled: true; message: string };
type IntelQueryResult =
  | {
      matches: Array<{ source: string; entries: Array<{ key: string; value: unknown }> }>;
      term: string;
      total: number;
    }
  | IntelDisabledResponse;
type IntelStatusResult =
  | {
      files: Record<string, { exists: boolean; updated_at: string | null; stale: boolean }>;
      overall_stale: boolean;
    }
  | IntelDisabledResponse;
type IntelDiffResult =
  | { changed: string[]; added: string[]; removed: string[] }
  | { no_baseline: true }
  | IntelDisabledResponse;
type IntelQueryData = Exclude<IntelQueryResult, IntelDisabledResponse>;
type IntelStatusData = Exclude<IntelStatusResult, IntelDisabledResponse>;
type IntelDiffData = Exclude<IntelDiffResult, IntelDisabledResponse | { no_baseline: true }>;

function hasIntelHelpers(value: unknown): value is {
  intelQuery: (term: string, planningDir: string) => IntelQueryResult;
  intelStatus: (planningDir: string) => IntelStatusResult;
  intelDiff: (planningDir: string) => IntelDiffResult;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "intelQuery" in value &&
    typeof value.intelQuery === "function" &&
    "intelStatus" in value &&
    typeof value.intelStatus === "function" &&
    "intelDiff" in value &&
    typeof value.intelDiff === "function"
  );
}

function getIntelHelpers(): {
  intelQuery: (term: string, planningDir: string) => IntelQueryResult;
  intelStatus: (planningDir: string) => IntelStatusResult;
  intelDiff: (planningDir: string) => IntelDiffResult;
} {
  if (hasIntelHelpers(intelModule)) {
    return intelModule;
  }

  throw new Error("GSD intel helper missing query helpers");
}

const { intelQuery, intelStatus, intelDiff } = getIntelHelpers();

function isDisabledIntelResponse(value: unknown): value is IntelDisabledResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "disabled" in value &&
    value.disabled === true &&
    "message" in value &&
    typeof value.message === "string"
  );
}

function normalizeQueryValue(query: string): string {
  return query.trim().toLowerCase();
}

function formatIntelQueryResult(result: IntelQueryData): string {
  const lines = [`Intel query term: ${result.term}`, `Matches: ${result.total}`];
  for (const match of result.matches) {
    lines.push(`Source: ${match.source} (${match.entries.length})`);
    for (const entry of match.entries.slice(0, 5)) {
      lines.push(`- ${entry.key}`);
    }
    if (match.entries.length > 5) {
      lines.push(`- ... ${match.entries.length - 5} more`);
    }
  }
  return lines.join("\n");
}

function formatIntelStatusResult(result: IntelStatusData): string {
  const lines = [`Intel status: ${result.overall_stale ? "stale" : "ready"}`];
  for (const [filename, status] of Object.entries(result.files).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const updatedAt = status.updated_at === null ? "" : `, updated ${status.updated_at}`;
    lines.push(
      `- ${filename}: ${status.exists ? "present" : "missing"}, ${status.stale ? "stale" : "fresh"}${updatedAt}`,
    );
  }
  return lines.join("\n");
}

function formatIntelDiffResult(result: IntelDiffData): string {
  const changed = result.changed.length === 0 ? "none" : result.changed.join(", ");
  const added = result.added.length === 0 ? "none" : result.added.join(", ");
  const removed = result.removed.length === 0 ? "none" : result.removed.join(", ");
  return [`Intel diff`, `Changed: ${changed}`, `Added: ${added}`, `Removed: ${removed}`].join("\n");
}

export function handleReadOnlyQueryMode(
  ctx: ExtensionCommandContext,
  args: GsdCommandArgs,
): boolean {
  if (args.query === undefined) {
    return false;
  }

  const normalizedQuery = normalizeQueryValue(args.query);
  if (normalizedQuery === "refresh") {
    ctx.ui.notify(
      "Unsupported /gsd map-codebase query mode: `--query refresh` is not implemented locally in this slice.",
      "warning",
    );
    return true;
  }

  const planningDir = resolvePlanningDir(ctx.cwd);
  let result: IntelQueryResult | IntelStatusResult | IntelDiffResult;
  if (normalizedQuery === "status") {
    result = intelStatus(planningDir);
  } else if (normalizedQuery === "diff") {
    result = intelDiff(planningDir);
  } else {
    result = intelQuery(args.query, planningDir);
  }

  if (isDisabledIntelResponse(result)) {
    ctx.ui.notify(result.message, "info");
    return true;
  }

  if (normalizedQuery === "status" && "files" in result) {
    ctx.ui.notify(formatIntelStatusResult(result), "info");
    return true;
  }

  if (normalizedQuery === "diff") {
    if ("no_baseline" in result && result.no_baseline) {
      ctx.ui.notify("Intel diff: no baseline snapshot available.", "info");
      return true;
    }
    if ("changed" in result) {
      ctx.ui.notify(formatIntelDiffResult(result), "info");
      return true;
    }
  }

  if ("matches" in result) {
    ctx.ui.notify(formatIntelQueryResult(result), "info");
  }

  return true;
}
