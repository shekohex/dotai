import type { GrepResult, SearchResult } from "@ff-labs/fff-node";
import {
  FIND_WEAK_SAMPLE_SIZE,
  GREP_MAX_LINE_LENGTH,
  HOT_FRECENCY,
  WARM_FRECENCY,
} from "./constants.js";

function truncateLine(line: string, max = GREP_MAX_LINE_LENGTH): string {
  const trimmed = line.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}...`;
}

// Shared annotation helper for both find-output paths and grep-output file
// headers. Returns at most ONE tag so output stays scannable. Priority:
// git-dirty (most actionable — file is changing right now) beats frecency
// (historically often-touched). Keeping one function ensures the two tools
// never drift in how they surface git/frecency signal.
export function fffFileAnnotation(item: {
  gitStatus?: string;
  totalFrecencyScore?: number;
  accessFrecencyScore?: number;
}): string {
  const git = item.gitStatus;
  if (git !== undefined && git !== "clean" && git !== "unknown" && git !== "") {
    return `  [${git} in git]`;
  }

  const frecency = item.totalFrecencyScore ?? item.accessFrecencyScore ?? 0;
  if (frecency >= HOT_FRECENCY) return "  [VERY often touched file]";
  if (frecency >= WARM_FRECENCY) return "  [often touched file]";

  return "";
}

// fff-core native definition classifier (byte-level scanner in Rust) is enabled
// via GrepOptions.classifyDefinitions. Each GrepMatch carries isDefinition for
// downstream consumers; pi-fff does NOT use it to re-sort.
//
// Ordering policy: NO CUSTOM SORTING. The engine already returns items in
// frecency order (most-accessed files first). pi-fff only groups consecutive
// matches into per-file blocks and preserves whatever order the engine
// provided — inside a file we keep matches in source-line order because the
// engine emits them that way.
export function formatGrepOutput(result: GrepResult): string {
  if (result.items.length === 0) return "No matches found";

  // Build file-grouped output in the order files first appear in the result.
  // This preserves native frecency ordering across files without re-sorting.
  const lines: string[] = [];
  let currentFile = "";

  for (const match of result.items) {
    if (match.relativePath !== currentFile) {
      if (lines.length > 0) lines.push("");
      currentFile = match.relativePath;
      lines.push(`${currentFile}${fffFileAnnotation(match)}`);
    }

    match.contextBefore?.forEach((line: string, i: number) => {
      const lineNum = match.lineNumber - match.contextBefore!.length + i;
      lines.push(` ${lineNum}- ${truncateLine(line)}`);
    });

    lines.push(` ${match.lineNumber}: ${truncateLine(match.lineContent)}`);

    match.contextAfter?.forEach((line: string, i: number) => {
      const lineNum = match.lineNumber + 1 + i;
      lines.push(` ${lineNum}- ${truncateLine(line)}`);
    });
  }

  return lines.join("\n");
}

// Weak-match threshold is derived from the query length, matching the
// scoring formula in crates/fff-core/src/score.rs: a perfect match scores
// `len * 16`, so we treat anything below 50% of that as scattered fuzzy noise.
// When the top score is weak, trim output to a small sample instead of dumping
// the full limit worth of noise into the agent's context.
function weakScoreThreshold(pattern: string): number {
  const perfect = pattern.length * 12;
  return Math.floor((perfect * 50) / 100);
}

export interface FormattedFind {
  output: string;
  weak: boolean;
  shownCount: number;
}

export function formatFindOutput(
  result: SearchResult,
  limit: number,
  pattern: string,
): FormattedFind {
  if (result.items.length === 0) {
    return {
      output: "No files found matching pattern",
      weak: false,
      shownCount: 0,
    };
  }

  // NO CUSTOM SORTING — trust native frecency order from the engine.
  const reordered = result.items.map((item) => ({ item }));

  // Peek at the top native score to decide whether results are scattered
  // fuzzy noise (query length-scaled threshold from score.rs).
  const topScore = result.scores[0]?.total ?? 0;
  const weak = topScore < weakScoreThreshold(pattern);
  const effective = weak ? Math.min(FIND_WEAK_SAMPLE_SIZE, limit) : limit;
  const shown = reordered.slice(0, effective);

  return {
    output: shown.map((p) => `${p.item.relativePath}${fffFileAnnotation(p.item)}`).join("\n"),
    weak,
    shownCount: shown.length,
  };
}
