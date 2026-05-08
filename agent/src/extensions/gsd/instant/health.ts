import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { asRecord, readString } from "../../../utils/unknown-data.js";
import type { GsdCommandArgs } from "../args.js";
import { resolveGsdBundlePath } from "../resources.js";
import {
  computeHealth,
  deriveHealthContextWindow,
  type ContextHealthOutput,
} from "../state/health.js";

const ContextHealthResultSchema = Type.Object(
  {
    percent: Type.Number(),
    state: Type.Union([Type.Literal("healthy"), Type.Literal("warning"), Type.Literal("critical")]),
    recommendation: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

const ContextHealthErrorSchema = Type.Object(
  {
    ok: Type.Boolean(),
    message: Type.String(),
  },
  { additionalProperties: true },
);

export function handleGsdHealth(
  _pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: GsdCommandArgs = {},
): void {
  if (args.unsupportedModeError !== undefined) {
    ctx.ui.notify(args.unsupportedModeError, "warning");
    return;
  }

  if (args.context === true) {
    const derivedUsage = deriveContextUsage(ctx, args);
    if (derivedUsage.tokensUsed === undefined) {
      ctx.ui.notify(formatUnknownContextHealthMessage(derivedUsage.contextWindow), "warning");
      return;
    }
    const result = runBundledContextHealth(
      ctx.cwd,
      derivedUsage.tokensUsed,
      derivedUsage.contextWindow,
    );
    const level = result.state === "healthy" ? "info" : "warning";
    ctx.ui.notify(formatContextHealthMessage(result), level);
    return;
  }

  const result = computeHealth(ctx.cwd, { repair: args.repair === true });
  const level = result.status === "healthy" ? "info" : "warning";
  ctx.ui.notify(formatHealthMessage(result), level);
}

function deriveContextUsage(
  ctx: ExtensionCommandContext,
  args: GsdCommandArgs,
): { tokensUsed?: string; contextWindow: string } {
  const usage = ctx.getContextUsage?.();
  let contextWindow = args.contextWindow;
  if (contextWindow === undefined) {
    if (usage !== undefined && Number.isInteger(usage.contextWindow) && usage.contextWindow > 0) {
      contextWindow = String(usage.contextWindow);
    } else {
      contextWindow = String(deriveHealthContextWindow(ctx.cwd).contextWindow);
    }
  }

  let tokensUsed = args.tokensUsed;
  if (
    tokensUsed === undefined &&
    usage !== undefined &&
    typeof usage.tokens === "number" &&
    Number.isInteger(usage.tokens) &&
    usage.tokens >= 0
  ) {
    tokensUsed = String(usage.tokens);
  }

  return {
    tokensUsed,
    contextWindow,
  };
}

function formatUnknownContextHealthMessage(contextWindow: string): string {
  return [
    "Health context unknown",
    `Window: ?/${contextWindow} tokens`,
    "Recommendation: token usage unavailable in current session. Re-run with --tokens-used <int> or from active session with context metrics.",
  ].join("\n");
}

function runBundledContextHealth(
  cwd: string,
  tokensUsed: string,
  contextWindow: string,
): ContextHealthOutput {
  const toolPath = resolveGsdBundlePath("bin", "gsd-tools.cjs");
  try {
    const stdout = execFileSync(
      process.execPath,
      [
        toolPath,
        "validate",
        "context",
        "--cwd",
        cwd,
        "--tokens-used",
        tokensUsed,
        "--context-window",
        contextWindow,
        "--json",
        "--json-errors",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const parsed = JSON.parse(stdout) as unknown;
    if (!Value.Check(ContextHealthResultSchema, parsed)) {
      throw new Error("Bundled context backend returned invalid JSON shape");
    }
    return {
      ...parsed,
      tokensUsed: Number(tokensUsed),
      contextWindow: Number(contextWindow),
      source: [],
    };
  } catch (error) {
    const message = extractContextHealthErrorMessage(error);
    return {
      percent: 0,
      state: "critical",
      recommendation: message,
      tokensUsed: Number(tokensUsed) || 0,
      contextWindow: Number(contextWindow) || 1,
      source: [],
    };
  }
}

function formatContextHealthMessage(result: ContextHealthOutput): string {
  const recommendation =
    result.recommendation === null ? "" : `\nRecommendation: ${result.recommendation}`;
  return (
    [
      `Health context ${result.percent}% ${result.state}`,
      `Window: ${result.tokensUsed}/${result.contextWindow} tokens`,
    ].join("\n") + recommendation
  );
}

function formatHealthMessage(result: ReturnType<typeof computeHealth>): string {
  const repairs = result.repairsPerformed?.length ?? 0;
  const counts = `errors=${countIssues(result.issues, "error")} warnings=${countIssues(result.issues, "warning")} info=${countIssues(result.issues, "info")}${repairs > 0 ? ` repairs=${repairs}` : ""}`;
  const detailLines = result.issues
    .slice(0, 8)
    .map((issue) => `${issue.severity.toUpperCase()} ${issue.code}: ${issue.message}`);
  const remainingCount = Math.max(result.issues.length - detailLines.length, 0);
  const remainingLine = remainingCount > 0 ? [`... ${remainingCount} more issues`] : [];
  const repairLines =
    result.repairsPerformed === undefined || result.repairsPerformed.length === 0
      ? []
      : ["Repairs:", ...result.repairsPerformed.map((repair) => formatRepairLine(repair))];
  return [
    `Health ${result.status} ${counts}`,
    ...detailLines,
    ...remainingLine,
    ...repairLines,
  ].join("\n");
}

function formatRepairLine(
  repair: NonNullable<ReturnType<typeof computeHealth>["repairsPerformed"]>[number],
): string {
  const record = asRecord(repair) ?? {};
  const parts = [`${repair.success ? "OK" : "FAIL"} ${repair.action}`];
  const path = readString(record.path);
  if (path !== undefined) {
    parts.push(`path=${path}`);
  }
  const detail = readString(record.detail);
  if (detail !== undefined) {
    parts.push(`detail=${detail}`);
  }
  const error = readString(record.error);
  if (error !== undefined) {
    parts.push(`error=${error}`);
  }
  return parts.join(" ");
}

function extractContextHealthErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Bundled context backend failed";
  }

  const stdout = "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
  const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
  for (const output of [stdout, stderr]) {
    if (output.length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(output) as unknown;
      if (Value.Check(ContextHealthErrorSchema, parsed)) {
        return parsed.message;
      }
    } catch {}
  }

  return error.message;
}

function countIssues(
  issues: ReturnType<typeof computeHealth>["issues"],
  severity: "error" | "warning" | "info",
): number {
  return issues.filter((issue) => issue.severity === severity).length;
}
