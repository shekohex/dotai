import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { parseMarkdownFrontmatter } from "./markdown.js";
import { resolvePlanningDir } from "../shared.js";

export const DebugSessionFrontmatterSchema = Type.Object(
  {
    slug: Type.Optional(Type.String()),
    status: Type.String(),
    trigger: Type.String(),
    goal: Type.Optional(Type.String()),
    created: Type.String(),
    updated: Type.String(),
  },
  { additionalProperties: false },
);

export type DebugSessionFrontmatter = Static<typeof DebugSessionFrontmatterSchema>;

export type DebugSession = {
  path: string;
  slug: string;
  frontmatter: DebugSessionFrontmatter;
  body: string;
  currentFocus: Record<string, string>;
  resolution: Record<string, string>;
  filesChanged: string[];
  hypothesis?: string;
  nextAction?: string;
  evidenceCount: number;
  eliminatedCount: number;
};

export function resolveDebugDir(cwd: string): string {
  return join(resolvePlanningDir(cwd), "debug");
}

export function ensureDebugDir(cwd: string): string {
  const debugDir = resolveDebugDir(cwd);
  mkdirSync(join(debugDir, "resolved"), { recursive: true });
  return debugDir;
}

export function readDebugSession(path: string): DebugSession | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  const content = readFileSync(path, "utf8");
  let parsed: ReturnType<typeof parseMarkdownFrontmatter<typeof DebugSessionFrontmatterSchema>>;
  try {
    parsed = parseMarkdownFrontmatter(content, DebugSessionFrontmatterSchema);
  } catch {
    return undefined;
  }
  if (!Value.Check(DebugSessionFrontmatterSchema, parsed.frontmatter)) {
    return undefined;
  }
  const currentFocus = extractSectionFields(parsed.body, "Current Focus");
  const resolution = extractSectionFields(parsed.body, "Resolution");
  const filesChanged = extractSectionList(parsed.body, "Resolution", "files_changed");
  const eliminated = extractSection(parsed.body, "Eliminated");
  return {
    path,
    slug: path.split("/").at(-1)?.replace(/\.md$/u, "") ?? "",
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    currentFocus,
    resolution,
    filesChanged,
    hypothesis: currentFocus.hypothesis,
    nextAction: currentFocus.next_action,
    evidenceCount: [...parsed.body.matchAll(/^- timestamp:/gmu)].length,
    eliminatedCount: [...eliminated.matchAll(/^- hypothesis:/gmu)].length,
  };
}

function extractSection(body: string, section: string): string {
  const lines = body.split("\n");
  const sectionHeader = `## ${section}`;
  const startIndex = lines.findIndex((line) => line.trim() === sectionHeader);
  if (startIndex === -1) {
    return "";
  }

  const sectionLines: string[] = [];
  for (const line of lines.slice(startIndex + 1)) {
    if (line.startsWith("## ")) {
      break;
    }
    sectionLines.push(line);
  }
  return sectionLines.join("\n");
}

function extractSectionFields(body: string, section: string): Record<string, string> {
  const sectionBody = extractSection(body, section);
  if (sectionBody.length === 0) {
    return {};
  }

  const sectionFields: Record<string, string> = {};
  for (const line of sectionBody.split("\n")) {
    const fieldMatch = line.match(/^\s*(?:-\s*)?([a-z_]+):\s*(.+)\s*$/u);
    if (fieldMatch?.[1] !== undefined && fieldMatch[2] !== undefined) {
      sectionFields[fieldMatch[1]] = fieldMatch[2].trim();
    }
  }
  return sectionFields;
}

function extractSectionList(body: string, section: string, field: string): string[] {
  const lines = extractSection(body, section).split("\n");
  const startIndex = lines.findIndex((line) => line.trim().startsWith(`${field}:`));
  if (startIndex === -1) {
    return [];
  }

  const fieldLine = lines[startIndex]?.trim() ?? "";
  const inlineMatch = fieldLine.match(new RegExp(`^${field}:\\s*\\[(.*)\\]$`, "u"));
  if (inlineMatch?.[1] !== undefined) {
    const inlineValues = inlineMatch[1]
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    return inlineValues;
  }

  const values: string[] = [];
  for (const line of lines.slice(startIndex + 1)) {
    if (/^\s*[a-z_]+:\s*/u.test(line)) {
      break;
    }
    const itemMatch = line.match(/^\s*[-*]\s+(.+)\s*$/u);
    if (itemMatch?.[1] !== undefined) {
      values.push(itemMatch[1].trim());
    }
  }
  return values;
}

export function listDebugSessions(cwd: string, resolved = false): DebugSession[] {
  const dir = resolved ? join(ensureDebugDir(cwd), "resolved") : ensureDebugDir(cwd);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => readDebugSession(join(dir, entry)))
    .filter((entry): entry is DebugSession => entry !== undefined)
    .toSorted((left, right) => right.frontmatter.updated.localeCompare(left.frontmatter.updated));
}

export function resolveActiveDebugSession(cwd: string, slug: string): DebugSession | undefined {
  return readDebugSession(join(ensureDebugDir(cwd), `${slug}.md`));
}

export function resolveDebugSession(cwd: string, slug: string): DebugSession | undefined {
  const active = resolveActiveDebugSession(cwd, slug);
  if (active) {
    return active;
  }
  return readDebugSession(join(ensureDebugDir(cwd), "resolved", `${slug}.md`));
}
