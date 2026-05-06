import { existsSync } from "node:fs";
import { join } from "node:path";

export type CodebaseMapFocus = "tech" | "arch" | "quality" | "concerns";
export type FastCodebaseMapFocus = CodebaseMapFocus | "tech+arch";

function buildRequiredReading(cwd: string): string[] {
  return [
    ".planning/PROJECT.md",
    ".planning/REQUIREMENTS.md",
    ".planning/ROADMAP.md",
    ".planning/STATE.md",
  ].filter((path) => existsSync(join(cwd, path)));
}

function buildCanonicalHeader(
  focus: CodebaseMapFocus,
  date: string,
  paths: string[],
  requiredReading: string[],
): string[] {
  return [
    `Focus: ${focus}`,
    `Today's date: ${date}`,
    ...(paths.length > 0 ? [`--paths ${paths.join(",")}`] : []),
    "",
    "<required_reading>",
    ...requiredReading,
    "</required_reading>",
    "",
  ];
}

function buildFastHeader(
  focus: FastCodebaseMapFocus,
  date: string,
  requiredReading: string[],
): string[] {
  return [
    `Focus: ${focus}`,
    `Today's date: ${date}`,
    "",
    "<required_reading>",
    ...requiredReading,
    "</required_reading>",
    "",
    "Partial scan mode: local `--fast`.",
    "This run is non-canonical and must only update target docs for requested focus.",
    "Do not treat this as a full codebase map refresh or baseline replacement.",
    "Preserve unrelated codebase docs outside this target set.",
    "",
  ];
}

function buildMapperBody(focus: CodebaseMapFocus, date: string): string[] {
  switch (focus) {
    case "tech":
      return [
        "Analyze this codebase for technology stack and external integrations.",
        "",
        "Write these documents to .planning/codebase/:",
        "- STACK.md - Languages, runtime, frameworks, dependencies, configuration",
        "- INTEGRATIONS.md - External APIs, databases, auth providers, webhooks",
        "",
        `IMPORTANT: Use ${date} for all [YYYY-MM-DD] date placeholders in documents.`,
        "",
        "Explore thoroughly. Write documents directly using templates. Return confirmation only.",
      ];
    case "arch":
      return [
        "Analyze this codebase architecture and directory structure.",
        "",
        "Write these documents to .planning/codebase/:",
        "- ARCHITECTURE.md - Pattern, layers, data flow, abstractions, entry points",
        "- STRUCTURE.md - Directory layout, key locations, naming conventions",
        "",
        `IMPORTANT: Use ${date} for all [YYYY-MM-DD] date placeholders in documents.`,
        "",
        "Explore thoroughly. Write documents directly using templates. Return confirmation only.",
      ];
    case "quality":
      return [
        "Analyze this codebase for coding conventions and testing patterns.",
        "",
        "Write these documents to .planning/codebase/:",
        "- CONVENTIONS.md - Code style, naming, patterns, error handling",
        "- TESTING.md - Framework, structure, mocking, coverage",
        "",
        `IMPORTANT: Use ${date} for all [YYYY-MM-DD] date placeholders in documents.`,
        "",
        "Explore thoroughly. Write documents directly using templates. Return confirmation only.",
      ];
    case "concerns":
      return [
        "Analyze this codebase for technical debt, known issues, and areas of concern.",
        "",
        "Write this document to .planning/codebase/:",
        "- CONCERNS.md - Tech debt, bugs, security, performance, fragile areas",
        "",
        `IMPORTANT: Use ${date} for all [YYYY-MM-DD] date placeholders in documents.`,
        "",
        "Explore thoroughly. Write document directly using template. Return confirmation only.",
      ];
  }

  return assertUnreachable(focus);
}

function assertUnreachable(_value: never): never {
  throw new Error("Unsupported codebase map focus");
}

export function buildMapperTask(
  focus: CodebaseMapFocus,
  date: string,
  paths: string[],
  cwd: string,
): string {
  const requiredReading = buildRequiredReading(cwd);
  return [
    ...buildCanonicalHeader(focus, date, paths, requiredReading),
    ...buildMapperBody(focus, date),
  ].join("\n");
}

export function buildFastMapperTask(
  focus: FastCodebaseMapFocus,
  date: string,
  cwd: string,
): string {
  const requiredReading = buildRequiredReading(cwd);
  const promptLines = buildFastHeader(focus, date, requiredReading);

  if (focus === "tech+arch") {
    return [
      ...promptLines,
      "Analyze this codebase for technology stack, integrations, architecture, and structure.",
      "",
      "Write these documents to .planning/codebase/:",
      "- STACK.md - Languages, runtime, frameworks, dependencies, configuration",
      "- INTEGRATIONS.md - External APIs, databases, auth providers, webhooks",
      "- ARCHITECTURE.md - Pattern, layers, data flow, abstractions, entry points",
      "- STRUCTURE.md - Directory layout, key locations, naming conventions",
      "",
      `IMPORTANT: Use ${date} for all [YYYY-MM-DD] date placeholders in documents.`,
      "",
      "Explore thoroughly. Write documents directly using templates. Return confirmation only.",
    ].join("\n");
  }

  return [...promptLines, ...buildMapperBody(focus, date)].join("\n");
}
