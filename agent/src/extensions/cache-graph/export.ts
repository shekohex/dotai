import { writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantUsageMetric, CacheSessionMetrics } from "./types.js";
import { summarizeHitPercent } from "./format-utils.js";

export function csvEscape(value: string | number | boolean | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

export function sanitizeFileName(name: string): string {
  const sanitized = name
    .trim()
    .replaceAll(/[^a-zA-Z0-9._-]+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^[-.]+|[-.]+$/g, "");

  return sanitized.length > 0 ? sanitized : "session";
}

function resolveSessionBaseName(
  sessionManager: Pick<SessionManager, "getSessionName" | "getSessionFile">,
): string {
  const sessionName = sessionManager.getSessionName()?.trim();
  if (sessionName !== undefined && sessionName.length > 0) return sanitizeFileName(sessionName);

  const sessionFile = sessionManager.getSessionFile();
  if (sessionFile !== undefined && sessionFile.length > 0) {
    return sanitizeFileName(basename(sessionFile, extname(sessionFile)));
  }

  return "session";
}

const headers = [
  "row_type",
  "scope",
  "assistant_messages",
  "sequence",
  "active_branch_sequence",
  "is_on_active_branch",
  "entry_id",
  "timestamp",
  "time",
  "provider",
  "model",
  "model_key",
  "prompt_tokens",
  "received_tokens",
  "cache_hit_tokens",
  "cache_write_tokens",
  "total_tokens",
  "cache_hit_percent",
  "delta_sent_tokens",
  "delta_received_tokens",
  "delta_cache_hit_tokens",
  "delta_cache_write_tokens",
  "delta_hit_rate_percent",
  "notes",
] as const;

type CsvHeader = (typeof headers)[number];
type CsvCell = string | number | boolean;
type CsvRow = Partial<Record<CsvHeader, CsvCell>>;

function summaryRows(metrics: CacheSessionMetrics): CsvRow[] {
  const treeHitRate = summarizeHitPercent(metrics.treeTotals);
  const branchHitRate = summarizeHitPercent(metrics.activeBranchTotals);

  return [
    {
      row_type: "summary",
      scope: "active_branch",
      assistant_messages: metrics.activeBranchTotals.assistantMessages,
      prompt_tokens:
        metrics.activeBranchTotals.input +
        metrics.activeBranchTotals.cacheRead +
        metrics.activeBranchTotals.cacheWrite,
      received_tokens: metrics.activeBranchTotals.output,
      cache_hit_tokens: metrics.activeBranchTotals.cacheRead,
      cache_write_tokens: metrics.activeBranchTotals.cacheWrite,
      total_tokens: metrics.activeBranchTotals.totalTokens,
      cache_hit_percent: branchHitRate,
      notes: "Matches the active-branch cumulative totals shown in /cache stats",
    },
    {
      row_type: "summary",
      scope: "whole_tree",
      assistant_messages: metrics.treeTotals.assistantMessages,
      prompt_tokens:
        metrics.treeTotals.input + metrics.treeTotals.cacheRead + metrics.treeTotals.cacheWrite,
      received_tokens: metrics.treeTotals.output,
      cache_hit_tokens: metrics.treeTotals.cacheRead,
      cache_write_tokens: metrics.treeTotals.cacheWrite,
      total_tokens: metrics.treeTotals.totalTokens,
      cache_hit_percent: treeHitRate,
      notes: "Matches the whole-tree cumulative totals shown in /cache stats",
    },
    {
      row_type: "summary",
      scope: "delta_tree_minus_branch",
      assistant_messages:
        metrics.treeTotals.assistantMessages - metrics.activeBranchTotals.assistantMessages,
      delta_sent_tokens: metrics.treeTotals.input - metrics.activeBranchTotals.input,
      delta_received_tokens: metrics.treeTotals.output - metrics.activeBranchTotals.output,
      delta_cache_hit_tokens: metrics.treeTotals.cacheRead - metrics.activeBranchTotals.cacheRead,
      delta_cache_write_tokens:
        metrics.treeTotals.cacheWrite - metrics.activeBranchTotals.cacheWrite,
      delta_hit_rate_percent: treeHitRate - branchHitRate,
      notes: "Matches the delta row shown in /cache stats",
    },
  ];
}

function messageRows(metrics: CacheSessionMetrics): CsvRow[] {
  return metrics.allMessages.map((metric: AssistantUsageMetric) => ({
    row_type: "message",
    scope: metric.isOnActiveBranch ? "active_branch" : "other_branch",
    sequence: metric.sequence,
    active_branch_sequence: metric.activeBranchSequence ?? "",
    is_on_active_branch: metric.isOnActiveBranch,
    entry_id: metric.entryId,
    timestamp: metric.timestamp,
    time: metric.timestamp.slice(11, 19),
    provider: metric.provider,
    model: metric.model,
    model_key: `${metric.provider}/${metric.model}`,
    prompt_tokens: metric.input + metric.cacheRead + metric.cacheWrite,
    received_tokens: metric.output,
    cache_hit_tokens: metric.cacheRead,
    cache_write_tokens: metric.cacheWrite,
    total_tokens: metric.totalTokens,
    cache_hit_percent: metric.cacheHitPercent,
    notes: "Matches a per-message row in /cache stats",
  }));
}

export function buildCsv(metrics: CacheSessionMetrics): string {
  const rows: CsvRow[] = [...summaryRows(metrics), ...messageRows(metrics)];
  const csvRows = [headers.join(",")];

  for (const row of rows) {
    csvRows.push(headers.map((header) => csvEscape(row[header])).join(","));
  }

  return csvRows.join("\n") + "\n";
}

export async function exportStatsCsv(
  cwd: string,
  sessionManager: Pick<SessionManager, "getSessionName" | "getSessionFile">,
  metrics: CacheSessionMetrics,
): Promise<string> {
  const fileBaseName = resolveSessionBaseName(sessionManager);
  const filePath = join(cwd, `${fileBaseName}.csv`);
  await writeFile(filePath, buildCsv(metrics), "utf8");
  return filePath;
}
