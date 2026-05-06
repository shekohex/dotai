import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { GsdCommandArgs } from "../args.js";
import { formatDetachedGsdFailure, runDetachedGsdJob } from "../detached-job.js";
import { resolvePlanningDir } from "../shared.js";
import { runRoleDetached } from "../subagents.js";
import { ensurePlanningDir } from "../state/write.js";
import {
  GSD_CODEBASE_MAP_SUMMARY_MESSAGE,
  type GsdCodebaseMapAreaSummary,
} from "../ui/messages.js";

type CodebaseMapFocus = "tech" | "arch" | "quality" | "concerns";

const documentsByFocus: Record<CodebaseMapFocus, string[]> = {
  tech: ["STACK.md", "INTEGRATIONS.md"],
  arch: ["ARCHITECTURE.md", "STRUCTURE.md"],
  quality: ["CONVENTIONS.md", "TESTING.md"],
  concerns: ["CONCERNS.md"],
};

const safeMapperPathPattern =
  /^(?!.*\.\.)(?:[A-Za-z0-9_.][A-Za-z0-9_.-]*)(?:\/[A-Za-z0-9_.][A-Za-z0-9_.-]*)*$/;

function assertUnreachable(_value: never): never {
  throw new Error("Unsupported codebase map focus");
}

function normalizeMapperPaths(paths: string[] | undefined): string[] {
  if (paths === undefined) {
    return [];
  }
  return [
    ...new Set(paths.map((path) => path.trim()).filter((path) => safeMapperPathPattern.test(path))),
  ];
}

function buildMapperTask(
  focus: CodebaseMapFocus,
  date: string,
  paths: string[],
  cwd: string,
): string {
  const optionalPlanningReads = [
    ".planning/PROJECT.md",
    ".planning/REQUIREMENTS.md",
    ".planning/ROADMAP.md",
    ".planning/STATE.md",
  ].filter((path) => existsSync(join(cwd, path)));
  const sharedHeader = [
    `Focus: ${focus}`,
    `Today's date: ${date}`,
    ...(paths.length > 0 ? [`--paths ${paths.join(",")}`] : []),
    "",
    "<required_reading>",
    ...optionalPlanningReads,
    "</required_reading>",
    "",
  ];

  switch (focus) {
    case "tech":
      return [
        ...sharedHeader,
        "Analyze this codebase for technology stack and external integrations.",
        "",
        "Write these documents to .planning/codebase/:",
        "- STACK.md - Languages, runtime, frameworks, dependencies, configuration",
        "- INTEGRATIONS.md - External APIs, databases, auth providers, webhooks",
        "",
        `IMPORTANT: Use ${date} for all [YYYY-MM-DD] date placeholders in documents.`,
        "",
        "Explore thoroughly. Write documents directly using templates. Return confirmation only.",
      ].join("\n");
    case "arch":
      return [
        ...sharedHeader,
        "Analyze this codebase architecture and directory structure.",
        "",
        "Write these documents to .planning/codebase/:",
        "- ARCHITECTURE.md - Pattern, layers, data flow, abstractions, entry points",
        "- STRUCTURE.md - Directory layout, key locations, naming conventions",
        "",
        `IMPORTANT: Use ${date} for all [YYYY-MM-DD] date placeholders in documents.`,
        "",
        "Explore thoroughly. Write documents directly using templates. Return confirmation only.",
      ].join("\n");
    case "quality":
      return [
        ...sharedHeader,
        "Analyze this codebase for coding conventions and testing patterns.",
        "",
        "Write these documents to .planning/codebase/:",
        "- CONVENTIONS.md - Code style, naming, patterns, error handling",
        "- TESTING.md - Framework, structure, mocking, coverage",
        "",
        `IMPORTANT: Use ${date} for all [YYYY-MM-DD] date placeholders in documents.`,
        "",
        "Explore thoroughly. Write documents directly using templates. Return confirmation only.",
      ].join("\n");
    case "concerns":
      return [
        ...sharedHeader,
        "Analyze this codebase for technical debt, known issues, and areas of concern.",
        "",
        "Write this document to .planning/codebase/:",
        "- CONCERNS.md - Tech debt, bugs, security, performance, fragile areas",
        "",
        `IMPORTANT: Use ${date} for all [YYYY-MM-DD] date placeholders in documents.`,
        "",
        "Explore thoroughly. Write document directly using template. Return confirmation only.",
      ].join("\n");
  }

  return assertUnreachable(focus);
}

export async function handleGsdMapCodebase(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: GsdCommandArgs = {},
): Promise<void> {
  ensurePlanningDir(ctx.cwd);
  const codebaseDir = join(resolvePlanningDir(ctx.cwd), "codebase");
  mkdirSync(codebaseDir, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const scopedPaths = normalizeMapperPaths(args.paths);
  const focusAreas: CodebaseMapFocus[] = ["tech", "arch", "quality", "concerns"];
  const startedRoles = await Promise.all(
    focusAreas.map((focus) =>
      runRoleDetached(
        pi,
        ctx,
        "codebase-mapper",
        buildMapperTask(focus, date, scopedPaths, ctx.cwd),
        {
          completion: false,
          name: `codebase-mapper:${focus}`,
        },
      ),
    ),
  );

  runDetachedGsdJob(
    pi,
    ctx,
    async () => {
      const results = await Promise.all(
        startedRoles.map(async (startedRole, index) => {
          const terminalState = await startedRole.waitForResult();
          return {
            focus: focusAreas[index],
            documents: documentsByFocus[focusAreas[index]],
            summary: terminalState.summary,
            capturedOutput: terminalState.capturedOutput,
            sessionId: terminalState.sessionId,
          } satisfies GsdCodebaseMapAreaSummary;
        }),
      );

      return results;
    },
    {
      startMessage: `Started codebase map: ${startedRoles.length} subagents`,
      successMessage: `Codebase map updated: ${codebaseDir}`,
      failureMessage: (error) => formatDetachedGsdFailure("Codebase map failed", error),
      onSuccess: (results) => {
        pi.sendMessage(
          {
            customType: GSD_CODEBASE_MAP_SUMMARY_MESSAGE,
            content: [
              "Codebase mapping complete.",
              "",
              "Updated `.planning/codebase/` via 4 mapper subagents:",
              "- tech: `STACK.md`, `INTEGRATIONS.md`",
              "- arch: `ARCHITECTURE.md`, `STRUCTURE.md`",
              "- quality: `CONVENTIONS.md`, `TESTING.md`",
              "- concerns: `CONCERNS.md`",
            ].join("\n"),
            display: true,
            details: {
              codebaseDir,
              areas: results,
            },
          },
          { deliverAs: "steer", triggerTurn: false },
        );
      },
    },
  );
}
