import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { parse as parseYaml } from "yaml";

import type { ManagedRepositoryConfig } from "./config.js";

export const LaunchRuleSchema = Type.Object({
  if: Type.Optional(Type.String()),
  flags: Type.Array(Type.String()),
});

export const WorkflowFrontmatterSchema = Type.Object({
  dispatchLabel: Type.Optional(Type.String()),
  branchTemplate: Type.Optional(Type.String()),
  branchPrefix: Type.Optional(Type.String()),
  branchKind: Type.Optional(Type.String()),
  baseRef: Type.Optional(Type.String()),
  statusField: Type.Optional(Type.String()),
  effortField: Type.Optional(Type.String()),
  priorityField: Type.Optional(Type.String()),
  statusOptions: Type.Optional(
    Type.Object({
      draft: Type.Optional(Type.String()),
      ready: Type.Optional(Type.String()),
      in_progress: Type.Optional(Type.String()),
      in_review: Type.Optional(Type.String()),
      done: Type.Optional(Type.String()),
      blocked: Type.Optional(Type.String()),
    }),
  ),
  launchRules: Type.Optional(Type.Array(LaunchRuleSchema)),
});

export const WorkflowFileSchema = Type.Object({
  path: Type.String(),
  frontmatter: WorkflowFrontmatterSchema,
  promptTemplate: Type.String(),
});

export type LaunchRule = Static<typeof LaunchRuleSchema>;
export type WorkflowFrontmatter = Static<typeof WorkflowFrontmatterSchema>;
export type WorkflowFile = Static<typeof WorkflowFileSchema>;

const DEFAULT_PROMPT_TEMPLATE = [
  "Implement GitHub issue ${{ github.issue.number }}: ${{ github.issue.title }}.",
  "",
  "Issue: ${{ github.issue.url }}",
  "Branch: ${{ conductor.branch }}",
  "Workspace: ${{ conductor.worktreePath }}",
  "",
  "Keep changes scoped. Open a pull request when ready. Run relevant checks and summarize proof.",
].join("\n");

export async function loadWorkflow(repoPath: string): Promise<WorkflowFile> {
  const workflowPath = join(repoPath, ".pi", "WORKFLOW.md");
  try {
    await access(workflowPath, constants.F_OK);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return Value.Parse(WorkflowFileSchema, {
        path: workflowPath,
        frontmatter: {},
        promptTemplate: DEFAULT_PROMPT_TEMPLATE,
      });
    }
    throw error;
  }

  return parseWorkflowFile(workflowPath, await readFile(workflowPath, "utf8"));
}

export function parseWorkflowFile(path: string, text: string): WorkflowFile {
  const { frontmatterText, body } = splitFrontmatter(text);
  const parsedYaml: unknown = frontmatterText.trim().length === 0 ? {} : parseYaml(frontmatterText);
  const frontmatter = Value.Parse(WorkflowFrontmatterSchema, parsedYaml ?? {});
  return Value.Parse(WorkflowFileSchema, {
    path,
    frontmatter,
    promptTemplate: body.trim().length > 0 ? body.trim() : DEFAULT_PROMPT_TEMPLATE,
  });
}

export function workflowConfigOverrides(workflow: WorkflowFile): Partial<ManagedRepositoryConfig> {
  const frontmatter = workflow.frontmatter;
  return {
    dispatchLabel: frontmatter.dispatchLabel,
    branchTemplate: frontmatter.branchTemplate,
    branchPrefix: frontmatter.branchPrefix,
    branchKind: frontmatter.branchKind,
    baseRef: frontmatter.baseRef,
    statusField: frontmatter.statusField,
    effortField: frontmatter.effortField,
    priorityField: frontmatter.priorityField,
    statusOptions: frontmatter.statusOptions,
  };
}

function splitFrontmatter(text: string): { frontmatterText: string; body: string } {
  if (!text.startsWith("---\n")) {
    return { frontmatterText: "", body: text };
  }

  const endIndex = text.indexOf("\n---", 4);
  if (endIndex === -1) {
    throw new Error(".pi/WORKFLOW.md frontmatter is missing closing ---");
  }

  const bodyStart = endIndex + 4;
  return {
    frontmatterText: text.slice(4, endIndex),
    body: text.slice(bodyStart).replace(/^\r?\n/u, ""),
  };
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && String(error.code) === code;
}
