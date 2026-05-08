import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { GsdCommandArgs } from "../args.js";
import { resolveGsdBundlePath } from "../resources.js";
import { computeHealth } from "../state/health.js";

const ContextHealthResultSchema = Type.Object(
  {
    percent: Type.Number(),
    state: Type.Union([Type.Literal("healthy"), Type.Literal("warning"), Type.Literal("critical")]),
    recommendation: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

type ContextHealthResult = Static<typeof ContextHealthResultSchema>;

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
    const result = runBundledContextHealth(
      ctx.cwd,
      args.tokensUsed ?? "",
      args.contextWindow ?? "",
    );
    const level = result.state === "healthy" ? "info" : "warning";
    const suffix = result.recommendation === null ? "" : ` ${result.recommendation}`;
    ctx.ui.notify(`Health context ${result.percent}% ${result.state}${suffix}`, level);
    return;
  }

  const result = computeHealth(ctx.cwd, { repair: args.repair === true });
  const level = result.status === "healthy" ? "info" : "warning";
  const repairs = result.repairsPerformed?.length ?? 0;
  const suffix = repairs > 0 ? ` repairs=${repairs}` : "";
  ctx.ui.notify(
    `Health ${result.status} errors=${countIssues(result.issues, "error")} warnings=${countIssues(result.issues, "warning")} info=${countIssues(result.issues, "info")}${suffix}`,
    level,
  );
}

function runBundledContextHealth(
  cwd: string,
  tokensUsed: string,
  contextWindow: string,
): ContextHealthResult {
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
    return parsed;
  } catch (error) {
    const message = extractContextHealthErrorMessage(error);
    return {
      percent: 0,
      state: "critical",
      recommendation: message,
    };
  }
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
