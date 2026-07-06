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

const WorkflowWorktreeHooksSchema = Type.Object({
  postCreate: Type.Optional(Type.Array(Type.String())),
  preRemove: Type.Optional(Type.Array(Type.String())),
  postRemove: Type.Optional(Type.Array(Type.String())),
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
  worktreeHooks: Type.Optional(WorkflowWorktreeHooksSchema),
});

export const WorkflowFileSchema = Type.Object({
  path: Type.String(),
  frontmatter: WorkflowFrontmatterSchema,
  promptTemplate: Type.String(),
});

export type LaunchRule = Static<typeof LaunchRuleSchema>;
export type WorkflowFrontmatter = Static<typeof WorkflowFrontmatterSchema>;
export type WorkflowFile = Static<typeof WorkflowFileSchema>;

const DEFAULT_PROMPT_BODY = [
  "<!--",
  "Conductor strips HTML comments from the prompt sent to the agent.",
  "Use comments for examples, repo notes, or syntax reminders you do not want in the live prompt.",
  "",
  "Expression examples:",
  "- ${{ github.repository }}",
  "- ${{ github.issue.number }} / ${{ github.issue.title }} / ${{ github.issue.body }} / ${{ github.issue.url }}",
  "- ${{ github.issue.labels }} / ${{ github.issue.assignees }}",
  "- ${{ github.project.status }} / ${{ github.project.priority }} / ${{ github.project.effort }}",
  "- ${{ conductor.branch }} / ${{ conductor.baseRef }} / ${{ conductor.worktreePath }} / ${{ conductor.runId }}",
  "- ${{ env.CI }} reads current process environment variables.",
  "- ${{ vars.NAME }} reads env var PI_CONDUCTOR_VAR_NAME.",
  "- ${{ secrets.NAME }} reads env var PI_CONDUCTOR_SECRET_NAME; use intentionally because values enter the prompt.",
  "",
  "Expression support:",
  "- dot paths, bracket paths, indexes, and object filters: github.project.fields['T-Shirt Size'], github.issue.labels[0], github.issue.labels.*.name",
  "- functions: contains(), startsWith(), endsWith(), join(), format(), toJSON(), fromJSON(), hashFiles(), success(), failure(), cancelled(), always()",
  "- operators: ==, !=, >, >=, <, <=, &&, ||, !",
  "- literals: strings, numbers, booleans, null",
  "Example: ${{ contains(github.issue.labels, 'ui') && github.project.priority == 'High' }}",
  "Launch rule if: values can be wrapped as ${{ ... }} or written bare.",
  "-->",
  "Role: autonomous implementation agent for ${{ github.repository }}.",
  "",
  "# Goal",
  "Resolve GitHub issue ${{ github.issue.number }} end to end: ${{ github.issue.title }}.",
  "",
  "Issue: ${{ github.issue.url }}",
  "Branch: ${{ conductor.branch }}",
  "Base: ${{ conductor.baseRef }}",
  "Workspace: ${{ conductor.worktreePath }}",
  "Run: ${{ conductor.runId }} attempt ${{ conductor.attempt }}",
  "",
  "# Issue Body",
  "${{ github.issue.body }}",
  "",
  "# Operating Mode",
  "Make progress autonomously. Ask for help only when missing information changes the implementation, secrets/auth are unavailable, or external/manual verification is required.",
  "",
  "Start by reading the issue, repo instructions, existing patterns, and relevant code. Keep changes scoped to this issue and preserve unrelated user work.",
  "",
  "If this run includes recovery context, user follow-up, PR review comments, or failing checks, treat that feedback as the current task. Address every actionable item, rerun relevant validation, and update the PR.",
  "",
  "# Delivery Workflow",
  "1. Diagnose the requested change and identify the smallest safe implementation.",
  "2. Edit code and tests. Prefer existing patterns over new abstractions.",
  "3. Run the most relevant validation available: targeted tests first, then typecheck/lint/build when applicable.",
  "4. Fix failures caused by your changes. If validation cannot run, record the blocker and next best check.",
  "5. Open or update a pull request for ${{ conductor.branch }} with summary, validation, and remaining blockers if any.",
  "",
  "# Success Criteria",
  "- Issue behavior is implemented or a precise blocker is reported.",
  "- Tests or checks cover changed behavior when practical.",
  "- Working tree contains only intentional changes for this issue.",
  "- Pull request is ready for review, or final response explains exactly why it could not be opened.",
].join("\n");

export const DEFAULT_WORKFLOW_MARKDOWN = [
  "---",
  "# Repo-owned Pi Conductor policy. Edit freely for this repository.",
  "# Conductor launches when an assigned issue has this label.",
  'dispatchLabel: "ready-for-agent"',
  "",
  "# Branch templates use ${{ }} expressions only.",
  'branchTemplate: "pi/${{ github.issue.number }}-${{ github.issue.slug }}"',
  "# Optional helpers available inside branchTemplate:",
  '# branchPrefix: "pi"',
  '# branchKind: "issue"',
  '# baseRef: "main"',
  "",
  "# Project field names. Override when your GitHub Project uses different field labels.",
  '# statusField: "Status"',
  '# effortField: "Effort"',
  '# priorityField: "Priority"',
  "",
  "# Project status option labels. Override to match your board exactly.",
  "# statusOptions:",
  '#   draft: "Todo"',
  '#   ready: "Ready"',
  '#   in_progress: "In Progress"',
  '#   in_review: "Review"',
  '#   done: "Done"',
  '#   blocked: "Blocked"',
  "",
  "# Ordered launch rules; first match wins. CLI flags still override these.",
  "launchRules:",
  "  - if: \"${{ contains(github.issue.labels, 'deep') || github.project.effort == 'XL' }}\"",
  "    flags:",
  "      - --mode-deep",
  "  - if: \"${{ contains(github.issue.labels, 'ui') }}\"",
  "    flags:",
  "      - --mode-painter",
  "  - if: \"${{ contains(github.issue.labels, 'ready-for-agent') }}\"",
  "    flags:",
  "      - --mode-build",
  "",
  "# Optional shell hooks. Commands run with cwd in the worktree for postCreate/preRemove.",
  "# Environment: REPO_ROOT, WORKTREE_PATH, BRANCH, PI_CONDUCTOR_OWNER, PI_CONDUCTOR_REPO, PI_CONDUCTOR_ISSUE_NUMBER.",
  "# For private/ignored hooks, use local git config instead:",
  '#   git config --local --add pi.conductor.hook.postCreate "cp ../.env .env || true"',
  "# worktreeHooks:",
  "#   postCreate:",
  "#     - npm install",
  "#   preRemove:",
  "#     - docker compose down || true",
  "#   postRemove:",
  '#     - echo "removed $WORKTREE_PATH"',
  "---",
  "",
  DEFAULT_PROMPT_BODY,
  "",
].join("\n");

const DEFAULT_PROMPT_TEMPLATE = stripWorkflowAuthorComments(DEFAULT_PROMPT_BODY).trim();

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
  const promptTemplate = stripWorkflowAuthorComments(body).trim();
  return Value.Parse(WorkflowFileSchema, {
    path,
    frontmatter,
    promptTemplate: promptTemplate.length > 0 ? promptTemplate : DEFAULT_PROMPT_TEMPLATE,
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
    worktreeHooks: frontmatter.worktreeHooks,
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

function stripWorkflowAuthorComments(markdown: string): string {
  return markdown.replaceAll(/<!--[\s\S]*?-->/g, "");
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && String(error.code) === code;
}
