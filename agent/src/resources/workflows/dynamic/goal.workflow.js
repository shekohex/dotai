export const meta = {
  name: "goal",
  description:
    "Execute a goal with checkpoint commits, review, deep judging, and fix loops until fully complete",
  phases: [
    { title: "Build", mode: "build" },
    { title: "Commit", mode: "commiter" },
    { title: "Review", mode: "review" },
    { title: "Judge", mode: "deep" },
    { title: "Fix", mode: "build" },
    { title: "Result", mode: "docs" },
  ],
};

const objective = (args && args.objective) || "";
const successCriteria = (args && args.successCriteria) || [];
const constraints = (args && args.constraints) || [];
const verificationCommands = (args && args.verificationCommands) || [];
const context = (args && args.context) || "";
const startCommit = (args && args.startCommit) || "";
const startedAt = (args && args.startedAt) || "";
const runId = (args && args.runId) || "";

const toMarkdown = (schema, value, level = 0) => {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return value.length ? value : "None";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const indent = "  ".repeat(level);
  if (Array.isArray(value)) {
    if (value.length === 0) return "None";
    return value
      .map((item) => {
        const rendered = toMarkdown(schema && schema.items, item, level + 1);
        if (item !== null && typeof item === "object") return indent + "-\n" + rendered;
        return indent + "- " + rendered;
      })
      .join("\n");
  }
  if (typeof value === "object") {
    const entries = Object.keys(value).map((key) => [key, value[key]]);
    if (entries.length === 0) return "None";
    return entries
      .map(([key, item]) => {
        const childSchema = schema && schema.properties && schema.properties[key];
        const description =
          childSchema && childSchema.description ? " — " + childSchema.description : "";
        const rendered = toMarkdown(childSchema, item, level + 1);
        if (item !== null && typeof item === "object")
          return indent + "- " + key + description + ":\n" + rendered;
        return indent + "- " + key + description + ": " + rendered;
      })
      .join("\n");
  }
  return String(value);
};

const section = (name, value) => ["<" + name + ">", value, "</" + name + ">"].join("\n");

const confidenceSection = section(
  "confidance",
  "Are you 100% confident in this strategy? is it the most ergonomic and optimized way of doing this? If not, find all possible loopholes, suggest proper fixes and run this loop until you are factually 100% confident in the new strategy.",
);

const goalContext = [
  section("objective", objective),
  section("success_criteria", toMarkdown(null, successCriteria)),
  section("constraints", toMarkdown(null, constraints)),
  section("verification_commands", toMarkdown(null, verificationCommands)),
  section("start_commit", startCommit),
  section("workflow_run_id", runId),
  section("additional_context", context),
].join("\n");

const commitSchema = {
  type: "object",
  description: "Checkpoint commit result for current goal progress.",
  properties: {
    committed: {
      type: "boolean",
      description: "True only when a git commit was created successfully.",
    },
    commit: {
      type: "string",
      description: "Commit hash or empty string when no commit was created.",
    },
    summary: {
      type: "string",
      description:
        "Conventional-commit style summary of what was committed or why nothing changed.",
    },
    blockers: {
      type: "array",
      description: "Reasons committing was unsafe or impossible. Empty when committed=true.",
      items: { type: "string" },
    },
  },
  required: ["committed", "commit", "summary", "blockers"],
};

const reviewSchema = {
  type: "object",
  description: "Strict code and evidence review result for current goal state.",
  properties: {
    ok: {
      type: "boolean",
      description:
        "True only when no code issues, proof gaps, regressions, builder-fixable work, external blockers, or human-review needs remain.",
    },
    commands: {
      type: "array",
      description: "Validation commands actually run, including failed commands.",
      items: { type: "string" },
    },
    findings: {
      type: "array",
      description: "Concrete review findings that must be addressed before completion.",
      items: { type: "string" },
    },
    requiredFixes: {
      type: "array",
      description: "Specific implementation or proof tasks needed to resolve findings.",
      items: { type: "string" },
    },
    evidence: {
      type: "array",
      description:
        "Concrete proof supporting ok=true, such as command results, diff checks, logs, or tests.",
      items: { type: "string" },
    },
    externalBlockers: {
      type: "array",
      description:
        "Only blockers the builder/fixer cannot address autonomously, such as missing credentials, unavailable external systems, or required user decisions.",
      items: { type: "string" },
    },
    needsHumanReview: {
      type: "boolean",
      description:
        "True only for extreme cases requiring human judgment or approval before any autonomous continuation is safe.",
    },
    humanReviewReason: {
      type: "string",
      description:
        "Specific reason human review is required, or empty string when needsHumanReview=false.",
    },
  },
  required: [
    "ok",
    "commands",
    "findings",
    "requiredFixes",
    "evidence",
    "externalBlockers",
    "needsHumanReview",
    "humanReviewReason",
  ],
};

const judgeSchema = {
  type: "object",
  description: "Deep whole-goal completion judgment, independent of code review cleanliness.",
  properties: {
    complete: {
      type: "boolean",
      description:
        "True only when the entire original goal, not just one slice, is fully satisfied.",
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 100,
      description: "Percent confidence that complete is correct based on available evidence.",
    },
    coveredCriteria: {
      type: "array",
      description: "Success criteria and objective parts proven complete.",
      items: { type: "string" },
    },
    missingCriteria: {
      type: "array",
      description:
        "Objective or success criteria still missing, partial, ambiguous, or weakly proven.",
      items: { type: "string" },
    },
    requiredWork: {
      type: "array",
      description: "Concrete next work needed before complete can be true.",
      items: { type: "string" },
    },
    evidence: {
      type: "array",
      description: "Evidence used to decide whole-goal completeness.",
      items: { type: "string" },
    },
    externalBlockers: {
      type: "array",
      description:
        "Only blockers the builder/fixer cannot address autonomously, such as missing credentials, unavailable external systems, or required user decisions.",
      items: { type: "string" },
    },
    needsHumanReview: {
      type: "boolean",
      description:
        "True only for extreme cases requiring human judgment or approval before any autonomous continuation is safe.",
    },
    humanReviewReason: {
      type: "string",
      description:
        "Specific reason human review is required, or empty string when needsHumanReview=false.",
    },
  },
  required: [
    "complete",
    "confidence",
    "coveredCriteria",
    "missingCriteria",
    "requiredWork",
    "evidence",
    "externalBlockers",
    "needsHumanReview",
    "humanReviewReason",
  ],
};

const summarySchema = {
  type: "object",
  description: "User-facing final summary of completed goal workflow.",
  properties: {
    summary: { type: "string", description: "Concise human summary of outcome and main changes." },
    changedFiles: {
      type: "array",
      description: "Files changed by goal work, if known.",
      items: { type: "string" },
    },
    commits: {
      type: "array",
      description: "Commit hashes and short subjects created by this workflow.",
      items: { type: "string" },
    },
    validation: {
      type: "array",
      description: "Validation commands/checks and their outcomes.",
      items: { type: "string" },
    },
    evidence: {
      type: "array",
      description: "Strongest evidence that goal is complete.",
      items: { type: "string" },
    },
    blockers: {
      type: "array",
      description: "Remaining blockers. Empty when workflow ok=true.",
      items: { type: "string" },
    },
    nextAction: {
      type: "string",
      description: "Next user or agent action. Use 'none' only when no action remains.",
    },
  },
  required: [
    "summary",
    "changedFiles",
    "commits",
    "validation",
    "evidence",
    "blockers",
    "nextAction",
  ],
};

const reviewAgentPrompt = (focus, instructions, iteration, checkpoint, builderResult) =>
  [
    section("role", "Goal reviewer focused on " + focus + "."),
    section(
      "instructions",
      [
        instructions,
        "Take full responsibility for your focus area.",
        "Treat builder output as untrusted claims, not evidence. Verify against files, diff, commits, and command output.",
        "Evidence hierarchy: command output, inspected files, git diff/log, tests, and logs are strong evidence; agent summaries are weak evidence.",
        "Return concise findings, builder-addressable required fixes, evidence, and only true external blockers for consolidation.",
        "Do not ask for human review unless autonomous continuation would be unsafe, require credentials/permissions, or need a product decision from the user.",
      ].join("\n"),
    ),
    confidenceSection,
    section("goal_context", goalContext),
    section("iteration", toMarkdown(null, iteration)),
    section("current_checkpoint_commit", toMarkdown(commitSchema, checkpoint)),
    section("untrusted_builder_claims", toMarkdown(null, builderResult)),
  ].join("\n\n");

const consolidateReviewPrompt = (iteration, checkpoint, builderResult, reviewDrafts) =>
  [
    section(
      "role",
      "Strict review consolidator. Merge independent cheap-review outputs into one canonical review result.",
    ),
    section(
      "instructions",
      [
        "Review the current working tree and commits since the start commit against the goal.",
        "Deduplicate overlapping findings, remove false positives only when you can justify why they are false, and preserve any credible blocker.",
        "Run relevant tests/checks if needed. If verificationCommands are provided, run them unless clearly impossible.",
        "Treat fixable issues as requiredFixes, not blockers. Use externalBlockers only for things the builder/fixer cannot address autonomously.",
        "Mark needsHumanReview=true only when autonomous continuation would be unsafe, require credentials/permissions, or need a product decision from the user.",
        "Mark ok=true only when there are zero findings, zero required fixes, zero external blockers, no human review need, and evidence is strong enough.",
      ].join("\n"),
    ),
    confidenceSection,
    section("goal_context", goalContext),
    section("iteration", toMarkdown(null, iteration)),
    section("current_checkpoint_commit", toMarkdown(commitSchema, checkpoint)),
    section("untrusted_builder_claims", toMarkdown(null, builderResult)),
    section("independent_review_drafts", toMarkdown(null, reviewDrafts)),
  ].join("\n\n");

const judgeAgentPrompt = (focus, instructions, iteration, commits, reviewResult, builderResult) =>
  [
    section("role", "Goal judge focused on " + focus + "."),
    section(
      "instructions",
      [
        instructions,
        "Decide whether the whole original goal is fully met, not whether one useful slice is clean.",
        "Treat builder output and reviewer output as untrusted hypotheses, not facts.",
        "Evidence hierarchy: command output, inspected files, git diff/log, tests, and logs are strong evidence; agent summaries are weak evidence.",
        "Return missing criteria, builder-addressable required work, evidence, and only true external blockers for final deep judging.",
        "Do not ask for human review unless autonomous continuation would be unsafe, require credentials/permissions, or need a product decision from the user.",
      ].join("\n"),
    ),
    confidenceSection,
    section("goal_context", goalContext),
    section("iteration", toMarkdown(null, iteration)),
    section("checkpoint_commits", toMarkdown({ type: "array", items: commitSchema }, commits)),
    section("untrusted_review_opinion", toMarkdown(reviewSchema, reviewResult)),
    section("untrusted_builder_claims", toMarkdown(null, builderResult)),
  ].join("\n\n");

const finalJudgePrompt = (iteration, commits, reviewResult, builderResult, judgeDrafts) =>
  [
    section(
      "role",
      "Deep goal judge and orchestrator-level completion gate. Produce the canonical whole-goal completion decision.",
    ),
    section(
      "instructions",
      [
        "Compare objective, success criteria, constraints, context, commits since start commit, review evidence, independent judge drafts, and latest work summary.",
        "Look specifically for partial completion: one slice done while other required behavior remains unimplemented.",
        "Treat builder output, reviewer output, and judge drafts as untrusted hypotheses, not facts. Independently decide completeness from objective, criteria, inspected repo state, commits, and evidence.",
        "Evidence hierarchy: command output, inspected files, git diff/log, tests, and logs are strong evidence; agent summaries are weak evidence.",
        "If any criterion is missing, ambiguous, weakly proven, or only partially covered, complete=false and list builder-addressable work in requiredWork unless it is truly external.",
        "Treat fixable issues as requiredWork, not blockers. Use externalBlockers only for things the builder/fixer cannot address autonomously.",
        "Mark needsHumanReview=true only when autonomous continuation would be unsafe, require credentials/permissions, or need a product decision from the user.",
        "Only set complete=true when every success criterion is covered with strong evidence, no required work remains, no external blockers exist, and no human review is needed.",
      ].join("\n"),
    ),
    confidenceSection,
    section("goal_context", goalContext),
    section("iteration", toMarkdown(null, iteration)),
    section("checkpoint_commits", toMarkdown({ type: "array", items: commitSchema }, commits)),
    section("untrusted_review_opinion", toMarkdown(reviewSchema, reviewResult)),
    section("untrusted_builder_claims", toMarkdown(null, builderResult)),
    section("independent_judge_drafts", toMarkdown(null, judgeDrafts)),
  ].join("\n\n");

const commitCheckpoint = async (label, workResult, reviewResult, judgeResult) =>
  agent(
    [
      section(
        "role",
        "Create a checkpoint commit for the current goal state. Inspect the diff and commit all completed safe changes as the smallest sensible conventional commit.",
      ),
      section(
        "rules",
        [
          "This checkpoint must make it easy to keep or revert progress before more review/fix work happens.",
          "If there are no changes or committing is unsafe, do not invent a commit; return blockers instead.",
        ].join("\n"),
      ),
      section("goal_context", goalContext),
      section("checkpoint_label", label),
      section("latest_work_result", toMarkdown(null, workResult)),
      section("untrusted_review_opinion", toMarkdown(reviewSchema, reviewResult || null)),
      section("untrusted_judge_opinion", toMarkdown(judgeSchema, judgeResult || null)),
    ].join("\n\n"),
    { label: label, mode: "commiter", schema: commitSchema },
  );

phase("Build");
let builderResult = await agent(
  [
    section(
      "role",
      "Autonomous goal executor working in a shared codebase. Resolve the whole goal end to end with proof, not just a plausible slice.",
    ),
    section(
      "instructions",
      [
        "Implement this goal in the working tree.",
        "Use the smallest safe change that satisfies the objective and every success criterion.",
        "Do not add speculative features, broaden scope, or hide uncertainty.",
        "Before claiming success, look for loopholes that could let one completed slice masquerade as the whole goal.",
        "Return concise summary, changed files, verification performed, remaining risks, and blockers if any.",
      ].join("\n"),
    ),
    confidenceSection,
    section("goal_context", goalContext),
  ].join("\n\n"),
  { label: "goal-builder", mode: "build" },
);

let iteration = 0;
let reviewCount = 0;
let judgeCount = 0;
let reviewDraftCount = 0;
let judgeDraftCount = 0;
let commitCount = 0;
let reviewResult = {
  ok: false,
  commands: [],
  findings: [],
  requiredFixes: [],
  evidence: [],
  externalBlockers: [],
  needsHumanReview: false,
  humanReviewReason: "",
};
let judgeResult = {
  complete: false,
  confidence: 0,
  coveredCriteria: [],
  missingCriteria: [],
  requiredWork: [],
  evidence: [],
  externalBlockers: [],
  needsHumanReview: false,
  humanReviewReason: "",
};
let fixResults = [];
let commits = [];

phase("Commit");
let checkpoint = await commitCheckpoint("goal-checkpoint-build", builderResult, null, null);
commits = commits.concat([checkpoint]);
if (checkpoint.committed) commitCount = commitCount + 1;

while (true) {
  phase("Review");
  const reviewDrafts = await parallel([
    () =>
      agent(
        reviewAgentPrompt(
          "correctness and regressions",
          "Inspect implementation correctness, behavior regressions, edge cases, and broken tests.",
          iteration,
          checkpoint,
          builderResult,
        ),
        { label: "review-code " + iteration, mode: "cheap-review" },
      ),
    () =>
      agent(
        reviewAgentPrompt(
          "proof and verification",
          "Inspect whether evidence and verification commands prove the goal. Find missing or weak proof.",
          iteration,
          checkpoint,
          builderResult,
        ),
        { label: "review-proof " + iteration, mode: "cheap-review" },
      ),
    () =>
      agent(
        reviewAgentPrompt(
          "scope and constraints",
          "Inspect constraints, non-goals, side effects, approvals, and whether changes stayed surgical.",
          iteration,
          checkpoint,
          builderResult,
        ),
        { label: "review-scope " + iteration, mode: "cheap-review" },
      ),
    () =>
      agent(
        reviewAgentPrompt(
          "ergonomics and maintainability",
          "Inspect simplicity, maintainability, API ergonomics, duplication, and long-term code quality.",
          iteration,
          checkpoint,
          builderResult,
        ),
        { label: "review-ergonomics " + iteration, mode: "cheap-review" },
      ),
  ]);
  reviewDraftCount = reviewDraftCount + reviewDrafts.filter(Boolean).length;
  reviewResult = await agent(
    consolidateReviewPrompt(iteration, checkpoint, builderResult, reviewDrafts),
    { label: "goal-review " + iteration, mode: "review", schema: reviewSchema },
  );
  reviewCount = reviewCount + 1;

  phase("Judge");
  const judgeDrafts = await parallel([
    () =>
      agent(
        judgeAgentPrompt(
          "success criteria coverage",
          "Check each success criterion and identify anything not fully covered by implementation and evidence.",
          iteration,
          commits,
          reviewResult,
          builderResult,
        ),
        { label: "judge-criteria " + iteration, mode: "ask" },
      ),
    () =>
      agent(
        judgeAgentPrompt(
          "partial completion risk",
          "Look for slice-only completion: one useful part done while other required behavior remains missing.",
          iteration,
          commits,
          reviewResult,
          builderResult,
        ),
        { label: "judge-complete " + iteration, mode: "ask" },
      ),
    () =>
      agent(
        judgeAgentPrompt(
          "evidence quality",
          "Assess whether proof is strong enough and whether required validation was actually performed.",
          iteration,
          commits,
          reviewResult,
          builderResult,
        ),
        { label: "judge-evidence " + iteration, mode: "ask" },
      ),
    () =>
      agent(
        judgeAgentPrompt(
          "risk and blockers",
          "Identify unresolved blockers, risky assumptions, missing approvals, or unapproved side effects.",
          iteration,
          commits,
          reviewResult,
          builderResult,
        ),
        { label: "judge-risk " + iteration, mode: "ask" },
      ),
  ]);
  judgeDraftCount = judgeDraftCount + judgeDrafts.filter(Boolean).length;
  judgeResult = await agent(
    finalJudgePrompt(iteration, commits, reviewResult, builderResult, judgeDrafts),
    { label: "goal-judge " + iteration, mode: "deep", schema: judgeSchema },
  );
  judgeCount = judgeCount + 1;

  const hasReviewFindings = Boolean(
    (reviewResult.findings || []).length ||
    (reviewResult.requiredFixes || []).length ||
    (reviewResult.externalBlockers || []).length ||
    reviewResult.needsHumanReview,
  );
  const hasJudgeFindings = Boolean(
    (judgeResult.missingCriteria || []).length ||
    (judgeResult.requiredWork || []).length ||
    (judgeResult.externalBlockers || []).length ||
    judgeResult.needsHumanReview,
  );
  const hasExternalBlockers = Boolean(
    (reviewResult.externalBlockers || []).length ||
    (judgeResult.externalBlockers || []).length ||
    reviewResult.needsHumanReview ||
    judgeResult.needsHumanReview,
  );
  if (hasExternalBlockers) break;
  if (reviewResult.ok && !hasReviewFindings && judgeResult.complete && !hasJudgeFindings) break;

  phase("Fix");
  const fixResult = await agent(
    [
      section(
        "instructions",
        [
          "Continue your prior builder session and fix the reviewed/judged issues.",
          "Address every real finding. Do not stop after one slice if the judge identified missing criteria.",
          "Keep changes surgical. Re-run targeted checks when possible.",
          "If a requested fix is impossible or requires user approval, stop changing code and report the blocker clearly.",
        ].join("\n"),
      ),
      section("goal_context", goalContext),
      section(
        "review_findings",
        toMarkdown(reviewSchema.properties.findings, reviewResult.findings),
      ),
      section(
        "required_review_fixes",
        toMarkdown(reviewSchema.properties.requiredFixes, reviewResult.requiredFixes),
      ),
      section(
        "judge_missing_criteria",
        toMarkdown(judgeSchema.properties.missingCriteria, judgeResult.missingCriteria),
      ),
      section(
        "judge_required_work",
        toMarkdown(judgeSchema.properties.requiredWork, judgeResult.requiredWork),
      ),
      section(
        "blockers",
        toMarkdown(
          null,
          []
            .concat(reviewResult.externalBlockers || [])
            .concat(judgeResult.externalBlockers || [])
            .concat(reviewResult.humanReviewReason ? [reviewResult.humanReviewReason] : [])
            .concat(judgeResult.humanReviewReason ? [judgeResult.humanReviewReason] : []),
        ),
      ),
    ].join("\n\n"),
    { label: "goal-fix " + iteration, mode: "build", resume: builderResult },
  );
  fixResults = fixResults.concat([fixResult]);
  builderResult = fixResult;
  iteration = iteration + 1;

  phase("Commit");
  checkpoint = await commitCheckpoint(
    "goal-checkpoint-fix " + iteration,
    builderResult,
    reviewResult,
    judgeResult,
  );
  commits = commits.concat([checkpoint]);
  if (checkpoint.committed) commitCount = commitCount + 1;
}

phase("Result");
const finalBlockers = []
  .concat(reviewResult.externalBlockers || [])
  .concat(judgeResult.externalBlockers || [])
  .concat(reviewResult.humanReviewReason ? [reviewResult.humanReviewReason] : [])
  .concat(judgeResult.humanReviewReason ? [judgeResult.humanReviewReason] : []);
const ok = Boolean(reviewResult.ok && judgeResult.complete && finalBlockers.length === 0);
const status = ok ? "complete" : "blocked";
const summaryResult = await agent(
  [
    section(
      "instructions",
      [
        "Write the final goal completion summary for the user.",
        "Be concise, factual, and evidence-backed. Do not claim success beyond review and judge results.",
        "Include what changed, commits created, validation/proof, blockers, and next action if blocked.",
      ].join("\n"),
    ),
    section("goal_context", goalContext),
    section("workflow_ok", toMarkdown(null, ok)),
    section("workflow_status", status),
    section("builder_result", toMarkdown(null, builderResult)),
    section("review_result", toMarkdown(reviewSchema, reviewResult)),
    section("judge_result", toMarkdown(judgeSchema, judgeResult)),
    section("commits", toMarkdown({ type: "array", items: commitSchema }, commits)),
    section(
      "metrics",
      toMarkdown(null, {
        runId,
        startedAt,
        startCommit,
        iterations: iteration,
        reviewCount,
        judgeCount,
        reviewDraftCount,
        judgeDraftCount,
        commitCount,
        tokenBudgetSpent: budget.spent(),
      }),
    ),
  ].join("\n\n"),
  { label: "goal-summary", mode: "docs", schema: summarySchema },
);
return {
  ok,
  status,
  objective,
  summary: summaryResult,
  review: reviewResult,
  judge: judgeResult,
  build: builderResult,
  fixes: fixResults,
  commits,
  evidence: [].concat(reviewResult.evidence || []).concat(judgeResult.evidence || []),
  blockers: finalBlockers,
  metrics: {
    runId,
    startedAt,
    startCommit,
    iterations: iteration,
    reviewCount,
    judgeCount,
    reviewDraftCount,
    judgeDraftCount,
    commitCount,
    agentCalls:
      3 +
      reviewDraftCount +
      reviewCount +
      judgeDraftCount +
      judgeCount +
      fixResults.length +
      commits.length,
    tokenBudgetSpent: budget.spent(),
  },
};
