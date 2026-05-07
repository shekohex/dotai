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
      invalid_files?: Array<{ file: string; error: string; preferredOver?: string[] }>;
    }
  | IntelDisabledResponse;
type IntelStatusResult =
  | {
      files: Record<string, { exists: boolean; updated_at: string | null; stale: boolean }>;
      overall_stale: boolean;
      invalid_files?: Array<{ file: string; error: string; preferredOver?: string[] }>;
    }
  | IntelDisabledResponse;
type IntelDiffResult =
  | {
      changed: string[];
      added: string[];
      removed: string[];
      invalid_files?: Array<{ file: string; error: string; preferredOver?: string[] }>;
    }
  | {
      invalid_baseline: true;
      message: string;
      invalid_files?: Array<{ file: string; error: string; preferredOver?: string[] }>;
    }
  | { no_baseline: true }
  | IntelDisabledResponse;
type IntelQueryData = Exclude<IntelQueryResult, IntelDisabledResponse>;
type IntelStatusData = Exclude<IntelStatusResult, IntelDisabledResponse>;
type IntelDiffData = Exclude<IntelDiffResult, IntelDisabledResponse | { no_baseline: true }>;
type IntelDiffChangeData = Extract<
  IntelDiffData,
  { changed: string[]; added: string[]; removed: string[] }
>;

function isIntelDiffChangeData(value: IntelDiffData): value is IntelDiffChangeData {
  return "changed" in value && "added" in value && "removed" in value;
}

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
  if (result.invalid_files !== undefined) {
    for (const invalidFile of result.invalid_files) {
      lines.push(`Invalid intel file: ${invalidFile.file} (${invalidFile.error})`);
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
  if (result.invalid_files !== undefined) {
    for (const invalidFile of result.invalid_files) {
      lines.push(`Invalid intel file: ${invalidFile.file} (${invalidFile.error})`);
    }
  }
  return lines.join("\n");
}

function formatIntelDiffResult(result: IntelDiffData): string {
  if ("invalid_baseline" in result && result.invalid_baseline) {
    const lines = [result.message];
    if (result.invalid_files !== undefined) {
      for (const invalidFile of result.invalid_files) {
        lines.push(`Invalid intel file: ${invalidFile.file} (${invalidFile.error})`);
      }
    }
    return lines.join("\n");
  }

  if (!isIntelDiffChangeData(result)) {
    throw new Error("Unexpected intel diff result shape");
  }

  const diffResult = result;

  const changed = diffResult.changed.length === 0 ? "none" : diffResult.changed.join(", ");
  const added = diffResult.added.length === 0 ? "none" : diffResult.added.join(", ");
  const removed = diffResult.removed.length === 0 ? "none" : diffResult.removed.join(", ");
  const lines = [`Intel diff`, `Changed: ${changed}`, `Added: ${added}`, `Removed: ${removed}`];
  if (diffResult.invalid_files !== undefined) {
    for (const invalidFile of diffResult.invalid_files) {
      lines.push(`Invalid intel file: ${invalidFile.file} (${invalidFile.error})`);
    }
  }
  return lines.join("\n");
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
    return false;
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
    if ("changed" in result || ("invalid_baseline" in result && result.invalid_baseline)) {
      ctx.ui.notify(formatIntelDiffResult(result), "info");
      return true;
    }
  }

  if ("matches" in result) {
    ctx.ui.notify(formatIntelQueryResult(result), "info");
  }

  return true;
}
