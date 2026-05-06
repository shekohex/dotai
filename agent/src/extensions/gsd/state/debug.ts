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
  const parsed = parseMarkdownFrontmatter(content, DebugSessionFrontmatterSchema);
  if (!Value.Check(DebugSessionFrontmatterSchema, parsed.frontmatter)) {
    return undefined;
  }
  return {
    path,
    slug: path.split("/").at(-1)?.replace(/\.md$/u, "") ?? "",
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    hypothesis: extractSectionField(parsed.body, "hypothesis"),
    nextAction: extractSectionField(parsed.body, "next_action"),
    evidenceCount: [...parsed.body.matchAll(/^- timestamp:/gmu)].length,
    eliminatedCount: [...parsed.body.matchAll(/^- hypothesis:/gmu)].length,
  };
}

function extractSectionField(body: string, field: string): string | undefined {
  return body.match(new RegExp(`^${field}:\\s*(.+)$`, "mu"))?.[1]?.trim();
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

export function resolveDebugSession(cwd: string, slug: string): DebugSession | undefined {
  const active = readDebugSession(join(ensureDebugDir(cwd), `${slug}.md`));
  if (active) {
    return active;
  }
  return readDebugSession(join(ensureDebugDir(cwd), "resolved", `${slug}.md`));
}
