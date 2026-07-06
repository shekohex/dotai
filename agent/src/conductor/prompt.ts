import { mkdir, writeFile } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ResolvedRepositoryConfig } from "./config.js";
import { renderTemplate } from "./expression.js";
import { relativePromptPath, type WorktreePlan } from "./worktree.js";
import type { RunRecord, WorkItem } from "./store/types.js";
import type { WorkflowFile } from "./workflow.js";

export type RecoveryPromptFeedback = { kind: string; body: string; url?: string };

export type RecoveryPromptContext = {
  run: RunRecord;
  feedback: RecoveryPromptFeedback[];
  events: Array<{ kind: string; createdAt: string }>;
};

export type PromptRenderInput = {
  config: ResolvedRepositoryConfig;
  workflow: WorkflowFile;
  workItem: WorkItem;
  plan: WorktreePlan;
  runId: string;
  attempt: number;
  recovery?: boolean;
  recoveryContext?: RecoveryPromptContext;
};

export function buildExpressionContext(input: PromptRenderInput): Record<string, unknown> {
  const projectStatus = readProjectField(input.workItem, input.config.statusField);
  const projectEffort = readProjectField(input.workItem, input.config.effortField);
  const projectPriority = readProjectField(input.workItem, input.config.priorityField);
  const issue = {
    id: input.workItem.issueId,
    number: input.workItem.issueNumber,
    title: input.workItem.title,
    body: input.workItem.body,
    url: input.workItem.issueUrl,
    labels: input.workItem.labels,
    assignees: input.workItem.assignees,
  };
  const project = {
    itemId: input.workItem.projectItemId,
    status: projectStatus,
    effort: projectEffort,
    priority: projectPriority,
    fields: input.workItem.projectFields,
  };
  return {
    __hashFilesRoot: input.config.repoPath,
    env: process.env,
    vars: readPrefixedEnv("PI_CONDUCTOR_VAR_"),
    secrets: readPrefixedEnv("PI_CONDUCTOR_SECRET_"),
    matrix: {},
    needs: {},
    steps: {},
    inputs: {},
    runner: {
      os: platform(),
      arch: arch(),
      temp: tmpdir(),
    },
    github: {
      repository: `${input.workItem.owner}/${input.workItem.repo}`,
      owner: input.workItem.owner,
      repo: input.workItem.repo,
      issue,
      project,
      event: {
        issue,
        project,
      },
    },
    conductor: {
      runId: input.runId,
      attempt: input.attempt,
      owner: input.config.owner,
      repo: input.config.repo,
      repoPath: input.config.repoPath,
      branch: input.plan.branch,
      baseRef: input.plan.baseRef,
      worktreePath: input.plan.worktreePath,
      recovery: input.recovery ?? false,
      project: {
        status: projectStatus,
        effort: projectEffort,
        priority: projectPriority,
      },
    },
    issue: {
      number: input.workItem.issueNumber,
      title: input.workItem.title,
      body: input.workItem.body,
      url: input.workItem.issueUrl,
      labels: input.workItem.labels,
      assignees: input.workItem.assignees,
    },
    project: {
      ...input.workItem.projectFields,
      status: projectStatus,
      effort: projectEffort,
      priority: projectPriority,
    },
  };
}

export function renderInitialPrompt(input: PromptRenderInput): string {
  const rendered = renderTemplate(input.workflow.promptTemplate, buildExpressionContext(input));
  if (input.recovery !== true) return rendered;
  return [formatRecoveryPromptContext(input), "", rendered].join("\n");
}

function readPrefixedEnv(prefix: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) => {
      if (value === undefined || !key.startsWith(prefix)) return [];
      return [[key.slice(prefix.length), value]];
    }),
  );
}

function readProjectField(input: WorkItem, fieldName: string): unknown {
  return (
    input.projectFields[fieldName] ?? (fieldName === "Status" ? input.projectStatus : undefined)
  );
}

function formatRecoveryPromptContext(input: PromptRenderInput): string {
  const run = input.recoveryContext?.run;
  const feedback = input.recoveryContext?.feedback ?? [];
  const events = input.recoveryContext?.events ?? [];
  return [
    "Recovery attempt. Continue same issue/branch, inspect current workspace state first.",
    "",
    "Previous run state:",
    `- Run: ${input.runId}`,
    `- Attempt: ${input.attempt}`,
    `- Status: ${run?.status ?? "unknown"}`,
    `- Branch: ${input.plan.branch}`,
    `- Base: ${input.plan.baseRef}`,
    `- Worktree: ${input.plan.worktreePath}`,
    run?.prUrl === undefined ? undefined : `- PR: ${run.prUrl}`,
    run?.lastError === undefined ? undefined : `- Last error: ${run.lastError}`,
    run?.routedFeedbackKeys === undefined || run.routedFeedbackKeys.length === 0
      ? undefined
      : `- Routed feedback keys: ${run.routedFeedbackKeys.join(", ")}`,
    events.length === 0
      ? undefined
      : `- Recent events: ${events.map((event) => `${event.kind}@${event.createdAt}`).join(", ")}`,
    feedback.length === 0 ? undefined : "",
    feedback.length === 0 ? undefined : "Current actionable PR/check feedback:",
    ...feedback.map((item) => formatRecoveryFeedback(item)),
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function formatRecoveryFeedback(feedback: RecoveryPromptFeedback): string {
  return `- ${feedback.kind}${feedback.url === undefined ? "" : ` ${feedback.url}`}: ${feedback.body}`;
}

export async function writePromptArtifact(
  worktreePath: string,
  prompt: string,
): Promise<{ promptPath: string; promptRelativePath: string }> {
  const promptRelativePath = relativePromptPath();
  const promptPath = join(worktreePath, promptRelativePath);
  await mkdir(dirname(promptPath), { recursive: true });
  await writeFile(promptPath, `${prompt}\n`);
  return { promptPath, promptRelativePath };
}
