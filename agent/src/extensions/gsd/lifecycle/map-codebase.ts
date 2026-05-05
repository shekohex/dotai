import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { resolvePlanningDir } from "../shared.js";
import { spawnRole } from "../subagents.js";
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

function assertUnreachable(_value: never): never {
  throw new Error("Unsupported codebase map focus");
}

function buildMapperTask(focus: CodebaseMapFocus, date: string): string {
  const sharedHeader = [
    `Focus: ${focus}`,
    `Today's date: ${date}`,
    "",
    "<required_reading>",
    ".planning/PROJECT.md",
    ".planning/REQUIREMENTS.md",
    ".planning/ROADMAP.md",
    ".planning/STATE.md",
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
): Promise<void> {
  ensurePlanningDir(ctx.cwd);
  const codebaseDir = join(resolvePlanningDir(ctx.cwd), "codebase");
  mkdirSync(codebaseDir, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const focusAreas: CodebaseMapFocus[] = ["tech", "arch", "quality", "concerns"];
  const results = await Promise.all(
    focusAreas.map((focus) =>
      spawnRole(pi, ctx, "codebase-mapper", buildMapperTask(focus, date), { completion: false }),
    ),
  );

  const areaSummaries: GsdCodebaseMapAreaSummary[] = focusAreas.map((focus, index) => ({
    focus,
    documents: documentsByFocus[focus],
    summary: results[index]?.summary,
    capturedOutput: results[index]?.capturedOutput,
    sessionId: results[index]?.sessionId ?? "",
  }));

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
        areas: areaSummaries,
      },
    },
    { deliverAs: "steer", triggerTurn: false },
  );
  ctx.ui.notify(`Codebase map updated: ${codebaseDir}`, "info");
}
