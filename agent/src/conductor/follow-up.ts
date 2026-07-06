import { evaluateCondition, renderTemplate } from "./expression.js";
import type { PullRequestFeedback, PullRequestSummary } from "./github.js";
import type { ConductorDeliveryMode } from "./herdr.js";
import type { RunRecord } from "./store/types.js";
import type { WorkflowFile } from "./workflow.js";
import type { ResolvedRepositoryConfig } from "./config.js";

export type ConductorCommentEvent = "prAssociated" | "runCompleted" | "runStopped" | "runBlocked";

export type RenderedFollowUpMessage = {
  delivery: ConductorDeliveryMode;
  message: string;
  ruleNames: string[];
};

const CONDUCTOR_COMMENT_MARKER = "<!-- pi-conductor -->";

type RunTemplateContext = {
  conductor: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
  github: Record<string, unknown>;
};

export function renderFollowUpMessages(input: {
  config: ResolvedRepositoryConfig;
  feedback: PullRequestFeedback;
  pr: PullRequestSummary;
  run: RunRecord;
  workflow: WorkflowFile;
}): RenderedFollowUpMessage[] {
  const context = buildFollowUpContext(input);
  const rendered = (input.workflow.frontmatter.followUpRules ?? []).flatMap((rule) => {
    if (!evaluateCondition(rule.if, context)) return [];
    const message = renderTemplate(rule.template, context).trim();
    if (message.length === 0) return [];
    return [
      {
        delivery: rule.delivery ?? "followUp",
        message,
        ruleNames: rule.name === undefined ? [] : [rule.name],
      },
    ];
  });
  if (rendered.length === 0) {
    return [
      {
        delivery: "followUp",
        message: formatDefaultPullRequestFeedback(input.feedback),
        ruleNames: [],
      },
    ];
  }
  return joinConsecutiveFollowUps(rendered);
}

export function renderConductorComment(input: {
  config: ResolvedRepositoryConfig;
  event: ConductorCommentEvent;
  error?: string;
  pr?: PullRequestSummary;
  run: RunRecord;
  workflow: WorkflowFile;
}): string | undefined {
  const template = input.workflow.frontmatter.conductorComments?.[input.event];
  if (template?.enabled === false) return undefined;
  if (template?.template === undefined) return defaultConductorComment(input);
  return renderTemplate(template.template, buildConductorCommentContext(input)).trim();
}

export function validateWorkflowMessageTemplates(input: {
  config: ResolvedRepositoryConfig;
  workflow: WorkflowFile;
}): void {
  const run = sampleRun(input.config);
  const pr = samplePullRequest(run);
  for (const feedback of sampleFeedback()) {
    renderFollowUpMessages({ ...input, feedback, pr, run });
  }
  for (const event of ["prAssociated", "runCompleted", "runStopped", "runBlocked"] as const) {
    renderConductorComment({ ...input, event, pr, run, error: "Sample error" });
  }
}

function joinConsecutiveFollowUps(messages: RenderedFollowUpMessage[]): RenderedFollowUpMessage[] {
  const result: RenderedFollowUpMessage[] = [];
  for (const message of messages) {
    const previous = result.at(-1);
    if (previous?.delivery === message.delivery) {
      previous.message = `${previous.message}\n\n${message.message}`;
      previous.ruleNames.push(...message.ruleNames);
      continue;
    }
    result.push({ ...message });
  }
  return result.map((message) => ({
    ...message,
    message: withConductorCommentMarkerInstruction(message.message),
  }));
}

function buildFollowUpContext(input: {
  config: ResolvedRepositoryConfig;
  feedback: PullRequestFeedback;
  pr: PullRequestSummary;
  run: RunRecord;
}): Record<string, unknown> {
  const base = buildRunContext(input.config, input.run, input.pr);
  const feedback = normalizeFeedbackContext(input.feedback);
  return {
    ...base,
    feedback,
    github: {
      ...base.github,
      check: input.feedback.check ?? {},
      comment: input.feedback.comment ?? input.feedback.issue_comment ?? {},
      review: input.feedback.review ?? {},
      review_comment: input.feedback.review_comment ?? {},
    },
  };
}

function buildConductorCommentContext(input: {
  config: ResolvedRepositoryConfig;
  error?: string;
  pr?: PullRequestSummary;
  run: RunRecord;
}): Record<string, unknown> {
  const context = buildRunContext(input.config, input.run, input.pr);
  return {
    ...context,
    conductor: {
      ...context.conductor,
      error: input.error ?? "",
    },
  };
}

function buildRunContext(
  config: ResolvedRepositoryConfig,
  run: RunRecord,
  pr: PullRequestSummary | undefined,
): RunTemplateContext {
  const issue = {
    number: run.issueNumber,
    title: run.issueTitle,
    url: run.issueUrl,
  };
  const pullRequest =
    pr === undefined
      ? {
          number: run.prNumber ?? 0,
          url: run.prUrl ?? "",
          head_ref: run.branch,
          state: "",
          draft: false,
          merged_at: "",
        }
      : pullRequestContext(pr);
  return {
    env: process.env,
    github: {
      repository: `${run.owner}/${run.repo}`,
      owner: run.owner,
      repo: run.repo,
      issue,
      pull_request: pullRequest,
    },
    conductor: {
      runId: run.runId,
      owner: config.owner,
      repo: config.repo,
      repoPath: config.repoPath,
      branch: run.branch,
      baseRef: run.baseRef,
      worktreePath: run.worktreePath,
      attempt: run.attempt,
      commentMarker: CONDUCTOR_COMMENT_MARKER,
      status: run.status,
      prUrl: run.prUrl ?? "",
    },
  };
}

function normalizeFeedbackContext(feedback: PullRequestFeedback): Record<string, unknown> {
  return {
    key: feedback.key,
    kind: feedback.kind,
    body: feedback.body,
    url: feedback.url ?? "",
    author: feedback.author ?? "",
    check: feedback.check ?? {},
    comment: feedback.comment ?? feedback.issue_comment ?? {},
    review: feedback.review ?? {},
    review_comment: feedback.review_comment ?? {},
  };
}

function pullRequestContext(pr: PullRequestSummary): Record<string, unknown> {
  return {
    number: pr.number,
    url: pr.url,
    head_ref: pr.headRefName,
    state: pr.state,
    draft: pr.isDraft,
    merged_at: pr.mergedAt ?? "",
    linked_issue_numbers: pr.linkedIssueNumbers ?? [],
  };
}

function defaultConductorComment(input: {
  event: ConductorCommentEvent;
  error?: string;
  pr?: PullRequestSummary;
  run: RunRecord;
}): string {
  if (input.event === "prAssociated") {
    return `Pi Conductor associated PR: ${input.pr?.url ?? input.run.prUrl ?? ""}`;
  }
  if (input.event === "runCompleted") {
    return `Pi Conductor completed run ${input.run.runId}: ${input.pr?.url ?? input.run.prUrl ?? ""}`;
  }
  if (input.event === "runStopped") return `Pi Conductor stopped run ${input.run.runId}.`;
  const detail =
    input.error === undefined || input.error.length === 0 ? "" : `\n\nError: ${input.error}`;
  return `Pi Conductor blocked run ${input.run.runId}.${detail}`;
}

function formatDefaultPullRequestFeedback(feedback: {
  body: string;
  kind: string;
  url?: string;
}): string {
  return [
    `GitHub PR feedback (${feedback.kind}) needs follow-up.`,
    feedback.url === undefined ? undefined : `URL: ${feedback.url}`,
    "",
    feedback.body,
    "",
    "Address this on same branch and PR. Push fixes and summarize verification.",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function withConductorCommentMarkerInstruction(message: string): string {
  if (message.toLowerCase().includes(CONDUCTOR_COMMENT_MARKER)) return message;
  return [
    message,
    "",
    "If you post any GitHub comment or review response for this feedback, include this hidden marker exactly once so Conductor does not route your own comment back:",
    CONDUCTOR_COMMENT_MARKER,
  ].join("\n");
}

function sampleRun(config: ResolvedRepositoryConfig): RunRecord {
  return {
    runId: "sample-run",
    owner: config.owner,
    repo: config.repo,
    issueNumber: 1,
    issueUrl: `https://github.com/${config.owner}/${config.repo}/issues/1`,
    issueTitle: "Sample issue",
    projectItemId: "sample-project-item",
    status: "in_review",
    paused: false,
    attempt: 1,
    branch: "pi/1-sample-issue",
    baseRef: config.baseRef ?? "main",
    worktreePath: config.repoPath,
    promptPath: `${config.repoPath}/.pi/conductor/run/initial-prompt.md`,
    launchFlags: [],
    herdr: {},
    prNumber: 2,
    prUrl: `https://github.com/${config.owner}/${config.repo}/pull/2`,
    routedFeedbackKeys: [],
    createdAt: "2026-07-06T00:00:00.000Z",
    updatedAt: "2026-07-06T00:00:00.000Z",
  };
}

function samplePullRequest(run: RunRecord): PullRequestSummary {
  return {
    number: run.prNumber ?? 2,
    url: run.prUrl ?? `https://github.com/${run.owner}/${run.repo}/pull/2`,
    headRefName: run.branch,
    state: "OPEN",
    isDraft: false,
  };
}

function sampleFeedback(): PullRequestFeedback[] {
  return [
    { key: "review:1", kind: "review", body: "Review body", author: "reviewer", review: {} },
    {
      key: "review_comment:1",
      kind: "review_comment",
      body: "Inline body",
      author: "reviewer",
      review_comment: {},
    },
    {
      key: "issue_comment:1",
      kind: "issue_comment",
      body: "Issue comment body",
      author: "reviewer",
      issue_comment: {},
    },
    { key: "comment:1", kind: "comment", body: "PR comment body", author: "reviewer", comment: {} },
    {
      key: "check:test:failure",
      kind: "check",
      body: "Check test is failure.",
      check: { name: "test", conclusion: "failure" },
    },
  ];
}
