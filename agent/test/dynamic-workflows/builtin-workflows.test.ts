import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import {
  buildBuiltinWorkflowInvocationPrompt,
  formatBuiltinWorkflowsForSystemPrompt,
  listBuiltinWorkflows,
  listRunnableBuiltinWorkflows,
} from "../../src/extensions/dynamic-workflows/builtin-registry.js";
import { registerBuiltinWorkflows } from "../../src/extensions/dynamic-workflows/builtin-commands.js";
import {
  generateAdversarialReviewWorkflow,
  generateMultiPerspectiveWorkflow,
} from "../../src/extensions/dynamic-workflows/adversarial-review.js";
import {
  generateCodebaseAuditWorkflow,
  generateDeepResearchWorkflow,
} from "../../src/extensions/dynamic-workflows/deep-research.js";
import {
  loadWorkflowResource,
  transformWorkflowTemplate,
} from "../../src/extensions/dynamic-workflows/resource-workflows.js";
import { generateSimplifyWorkflow } from "../../src/extensions/dynamic-workflows/simplify.js";
import {
  parseWorkflowScript,
  runWorkflow,
} from "../../src/extensions/dynamic-workflows/workflow.js";

test("generateDeepResearchWorkflow produces a valid, parseable script", () => {
  const { meta, body } = parseWorkflowScript(generateDeepResearchWorkflow());
  assert.equal(meta.name, "deep_research");
  assert.deepEqual(
    meta.phases?.map((p) => p.title),
    ["Queries", "Gather", "Verify", "Report"],
  );
  // Reads inputs from args (no string interpolation) and uses built-in websearch.
  assert.match(body, /args && args\.question/);
  assert.match(body, /websearch/);
});

test("generateAdversarialReviewWorkflow produces a valid, parseable script", () => {
  const { meta, body } = parseWorkflowScript(generateAdversarialReviewWorkflow());
  assert.equal(meta.name, "adversarial_review");
  assert.match(body, /args && args\.task/);
  assert.match(body, /mode: "review"/);
  assert.match(body, /mode: "cheap-review"/);
  // Uses the agreement threshold to decide survivors.
  assert.match(body, /threshold/);
  assert.match(body, /survives/);
});

test("deep research workflow pins research-specific modes", () => {
  const { body } = parseWorkflowScript(generateDeepResearchWorkflow());
  assert.match(body, /mode: "ask"/);
  assert.match(body, /mode: "websearch"/);
  assert.match(body, /mode: "docs"/);
});

test("built-in workflows load from bundled resources", () => {
  assert.equal(generateDeepResearchWorkflow(), loadWorkflowResource("deep-research.workflow.js"));
  assert.equal(
    generateAdversarialReviewWorkflow(),
    loadWorkflowResource("adversarial-review.workflow.js"),
  );
  assert.equal(generateSimplifyWorkflow(), loadWorkflowResource("simplify.workflow.js"));
});

test("built-in workflow registry lists workflows deterministically", () => {
  const workflows = listBuiltinWorkflows();
  assert.deepEqual(
    workflows.map((workflow) => workflow.commandName),
    ["wf:adversarial-review", "wf:deep-research", "wf:goal", "wf:simplify"],
  );
  assert.ok(workflows.every((workflow) => workflow.filePath.endsWith(".workflow.js")));
  assert.ok(workflows.every((workflow) => !workflow.description.includes("__description__")));
});

test("built-in workflow prompt catalog is stable and points agents at scriptFile", () => {
  const prompt = formatBuiltinWorkflowsForSystemPrompt(listRunnableBuiltinWorkflows());
  assert.match(prompt, /<workflows>/);
  assert.match(prompt, /\/wf:<name> => src\/resources\/workflows\/dynamic\/<name>\.workflow\.js/);
  assert.match(prompt, /n="adversarial-review"/);
  assert.match(prompt, /n="deep-research"/);
  assert.doesNotMatch(prompt, /n="goal"/);
  assert.doesNotMatch(prompt, /n="wf:/);
  assert.match(prompt, /scriptFile\+args/);
  assert.match(prompt, /scriptFile/);
  assert.doesNotMatch(prompt, /codebase-audit/);
  assert.doesNotMatch(prompt, /multi-perspective/);
});

test("built-in workflow invocation prompt preserves user context", () => {
  const workflow = listBuiltinWorkflows().find(
    (item) => item.commandName === "wf:adversarial-review",
  );
  assert.ok(workflow);
  const prompt = buildBuiltinWorkflowInvocationPrompt(workflow, "review auth diff");
  assert.match(prompt, /Use built-in dynamic workflow `wf:adversarial-review`/);
  assert.match(prompt, /<workflow_description>/);
  assert.match(prompt, /Workflow file: `adversarial-review\.workflow\.js`/);
  assert.match(prompt, /detailed standalone prompt/);
  assert.match(prompt, /workflow` tool/);
  assert.match(prompt, /<additional_context>\nreview auth diff\n<\/additional_context>/);
  assert.doesNotMatch(prompt, /\/home\/coder/);
  assert.doesNotMatch(prompt, /<auto_context>/);
});

test("built-in workflow slash commands send follow-up user turns", async () => {
  const commands = new Map<
    string,
    { handler: (args: string, ctx: ExtensionCommandContext) => void }
  >();
  const sent: Array<{ content: string; options?: { deliverAs?: string } }> = [];
  let enabled = false;
  const pi = {
    getCommands: () => [],
    registerCommand(
      name: string,
      command: { handler: (args: string, ctx: ExtensionCommandContext) => void },
    ) {
      commands.set(name, command);
    },
    sendUserMessage(content: string, options?: { deliverAs?: string }) {
      sent.push({ content, options });
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    ui: { notify() {} },
  } as unknown as ExtensionCommandContext;

  registerBuiltinWorkflows(pi, {
    enableWorkflowTool: () => {
      enabled = true;
    },
  });

  await commands.get("wf:adversarial-review")?.handler("review auth diff", ctx);

  assert.equal(enabled, true);
  assert.equal(sent[0]?.options?.deliverAs, "followUp");
  assert.match(sent[0]?.content ?? "", /review auth diff/);
});

test("simplify workflow produces a valid, parseable script", () => {
  const { meta, body } = parseWorkflowScript(generateSimplifyWorkflow());
  assert.equal(meta.name, "simplify");
  assert.deepEqual(
    meta.phases?.map((phase) => phase.title),
    ["Code Review", "Fix Issues"],
  );
  assert.match(body, /reuse-review/);
  assert.match(body, /simplification-review/);
  assert.match(body, /efficiency-review/);
  assert.match(body, /altitude-review/);
  assert.match(body, /simplify-fixer/);
});

test("existing simplify workflow remains compatible with session-backed text results", async () => {
  const result = await runWorkflow(generateSimplifyWorkflow(), {
    persistLogs: false,
    args: {
      diffCommand: "git diff --cached",
      status: "M src/example.ts",
      stat: "src/example.ts | 1 +",
      context: "compatibility test",
    },
    agent: {
      async run(
        prompt: string,
        options: { onStart?: (state: { sessionId: string; sessionPath: string }) => void },
      ) {
        const label = /Code Reuse Review/.test(prompt)
          ? "reuse"
          : /Simplification Review/.test(prompt)
            ? "simplification"
            : /Efficiency Review/.test(prompt)
              ? "efficiency"
              : /Altitude Review/.test(prompt)
                ? "altitude"
                : "fix";
        options.onStart?.({ sessionId: `session-${label}`, sessionPath: `/tmp/session-${label}` });
        return `${label} result`;
      },
    },
  });

  assert.deepEqual(result.result, {
    reviews: ["reuse result", "simplification result", "efficiency result", "altitude result"],
    fixes: "fix result",
  });
});

test("workflow resources start with exported metadata", () => {
  for (const resourceName of [
    "adversarial-review.workflow.js",
    "auto-generated.workflow.js",
    "codebase-audit.workflow.js",
    "deep-research.workflow.js",
    "goal.workflow.js",
    "multi-perspective.workflow.js",
    "simplify.workflow.js",
  ]) {
    assert.match(loadWorkflowResource(resourceName), /^export const meta = /);
  }
});

test("goal workflow produces a valid, parseable script", () => {
  const { meta, body } = parseWorkflowScript(loadWorkflowResource("goal.workflow.js"));
  assert.equal(meta.name, "goal");
  assert.deepEqual(
    meta.phases?.map((phase) => phase.title),
    ["Build", "Commit", "Review", "Judge", "Fix", "Result"],
  );
  assert.match(body, /resume: builderResult/);
  assert.doesNotMatch(body, /maxIterations/);
  assert.match(body, /reviewSchema/);
  assert.match(body, /commitSchema/);
  assert.match(body, /judgeSchema/);
  assert.match(body, /summarySchema/);
  assert.match(body, /confidence: \{/);
  assert.match(body, /maximum: 100/);
  assert.match(body, /toMarkdown\(/);
  assert.match(body, /value instanceof String/);
  assert.match(body, /section\("objective"/);
  assert.match(body, /section\("goal_context"/);
  assert.match(body, /section\("unblock_reason"/);
  assert.match(body, /unblockedAt/);
  assert.match(body, /requiredWorkItemsFrom/);
  assert.match(body, /"required_work_items"/);
  assert.doesNotMatch(body, /"review_findings"/);
  assert.doesNotMatch(body, /"required_review_fixes"/);
  assert.doesNotMatch(body, /"judge_missing_criteria"/);
  assert.doesNotMatch(body, /"judge_required_work"/);
  assert.match(body, /untrusted_builder_claims/);
  assert.match(body, /untrusted_review_opinion/);
  assert.match(body, /Evidence hierarchy/);
  assert.match(body, /review-code/);
  assert.match(body, /review-proof/);
  assert.match(body, /judge-criteria/);
  assert.match(body, /judge-evidence/);
  assert.match(body, /<" \+ name \+ ">/);
  assert.match(body, /startCommit/);
  assert.match(body, /tokenBudgetSpent/);
  assert.match(body, /resume autonomous fixing/);
  assert.match(body, /resolve external blockers and resume workflow/);
});

test("goal workflow returns completion evidence when review and judge pass", async () => {
  const result = await runWorkflow(loadWorkflowResource("goal.workflow.js"), {
    persistLogs: false,
    args: {
      objective: "ship test goal",
      verificationCommands: ["npm test"],
      startCommit: "start123",
    },
    agent: {
      async run(prompt: string) {
        if (/Create a checkpoint commit/.test(prompt)) {
          return {
            committed: true,
            commit: "abc123",
            summary: "feat: ship test goal",
            blockers: [],
          };
        }
        if (/Review the current/.test(prompt)) {
          return {
            ok: true,
            commands: ["npm test"],
            findings: [],
            requiredFixes: [],
            evidence: ["tests passed"],
            externalBlockers: [],
            needsHumanReview: false,
            humanReviewReason: "",
          };
        }
        if (/Deep goal judge/.test(prompt)) {
          return {
            complete: true,
            confidence: 100,
            coveredCriteria: ["ship test goal"],
            missingCriteria: [],
            requiredWork: [],
            evidence: ["goal fully covered"],
            externalBlockers: [],
            needsHumanReview: false,
            humanReviewReason: "",
          };
        }
        if (/final goal completion summary/.test(prompt)) {
          return {
            summary: "Goal shipped",
            changedFiles: ["src/example.ts"],
            commits: ["abc123"],
            validation: ["npm test"],
            evidence: ["tests passed", "goal fully covered"],
            blockers: [],
            nextAction: "none",
          };
        }
        return "built goal";
      },
    },
  });

  assert.equal(result.result.ok, true);
  assert.equal(result.result.objective, "ship test goal");
  assert.deepEqual(Array.from(result.result.evidence), ["tests passed", "goal fully covered"]);
  assert.deepEqual(Array.from(result.result.blockers), []);
  assert.equal(result.result.metrics.startCommit, "start123");
  assert.equal(result.result.metrics.commitCount, 1);
  assert.equal(result.result.metrics.reviewDraftCount, 4);
  assert.equal(result.result.metrics.judgeDraftCount, 4);
  assert.equal(result.result.summary.summary, "Goal shipped");
});

test("goal workflow keeps fixing until review findings and judge gaps are gone", async () => {
  let reviewCalls = 0;
  let judgeCalls = 0;
  let fixCalls = 0;
  const result = await runWorkflow(loadWorkflowResource("goal.workflow.js"), {
    persistLogs: false,
    args: { objective: "close loop" },
    agent: {
      async run(
        prompt: string,
        options: { onStart?: (state: { sessionId: string; sessionPath: string }) => void },
      ) {
        options.onStart?.({ sessionId: "goal-builder-session", sessionPath: "/tmp/goal-builder" });
        if (/Create a checkpoint commit/.test(prompt)) {
          return { committed: true, commit: "def456", summary: "feat: close loop", blockers: [] };
        }
        if (/Review the current/.test(prompt)) {
          reviewCalls = reviewCalls + 1;
          if (reviewCalls === 1) {
            return {
              ok: false,
              commands: [],
              findings: ["missing proof"],
              requiredFixes: ["collect proof"],
              evidence: [],
              externalBlockers: [],
              needsHumanReview: false,
              humanReviewReason: "",
            };
          }
          return {
            ok: true,
            commands: [],
            findings: [],
            requiredFixes: [],
            evidence: ["review clean"],
            externalBlockers: [],
            needsHumanReview: false,
            humanReviewReason: "",
          };
        }
        if (/Deep goal judge/.test(prompt)) {
          judgeCalls = judgeCalls + 1;
          if (judgeCalls === 1) {
            return {
              complete: false,
              confidence: 60,
              coveredCriteria: [],
              missingCriteria: ["full proof"],
              requiredWork: ["finish proof"],
              evidence: [],
              externalBlockers: [],
              needsHumanReview: false,
              humanReviewReason: "",
            };
          }
          return {
            complete: true,
            confidence: 100,
            coveredCriteria: ["full proof"],
            missingCriteria: [],
            requiredWork: [],
            evidence: ["judge clean"],
            externalBlockers: [],
            needsHumanReview: false,
            humanReviewReason: "",
          };
        }
        if (/final goal completion summary/.test(prompt)) {
          return {
            summary: "Loop closed",
            changedFiles: [],
            commits: ["def456"],
            validation: [],
            evidence: ["judge clean"],
            blockers: [],
            nextAction: "none",
          };
        }
        if (/Continue the prior work session/.test(prompt)) {
          fixCalls = fixCalls + 1;
          assert.match(prompt, /<required_work_items>/);
          assert.match(prompt, /missing proof/);
          assert.match(prompt, /collect proof/);
          assert.match(prompt, /full proof/);
          assert.match(prompt, /finish proof/);
          return "fixed proof";
        }
        return "built goal";
      },
    },
  });

  assert.equal(result.result.ok, true);
  assert.equal(reviewCalls, 2);
  assert.equal(judgeCalls, 2);
  assert.equal(fixCalls, 1);
  assert.equal(result.result.metrics.iterations, 1);
  assert.equal(result.result.metrics.commitCount, 2);
  assert.equal(result.result.metrics.reviewDraftCount, 8);
  assert.equal(result.result.metrics.judgeDraftCount, 8);
});

test("goal workflow blocks instead of fixing when human review is required", async () => {
  const result = await runWorkflow(loadWorkflowResource("goal.workflow.js"), {
    persistLogs: false,
    args: { objective: "needs external approval" },
    agent: {
      async run(prompt: string) {
        if (/Create a checkpoint commit/.test(prompt)) {
          return { committed: true, commit: "ghi789", summary: "feat: checkpoint", blockers: [] };
        }
        if (/Review the current/.test(prompt)) {
          return {
            ok: false,
            commands: [],
            findings: [],
            requiredFixes: [],
            evidence: [],
            externalBlockers: ["Need production credential from user"],
            needsHumanReview: true,
            humanReviewReason: "User must approve production credential use.",
          };
        }
        if (/Deep goal judge/.test(prompt)) {
          return {
            complete: false,
            confidence: 20,
            coveredCriteria: [],
            missingCriteria: [],
            requiredWork: [],
            evidence: [],
            externalBlockers: [],
            needsHumanReview: false,
            humanReviewReason: "",
          };
        }
        if (/final goal completion summary/.test(prompt)) {
          return {
            summary: "Blocked on approval",
            changedFiles: [],
            commits: ["ghi789"],
            validation: [],
            evidence: [],
            blockers: ["Need production credential from user"],
            nextAction: "user approval required",
          };
        }
        return "built goal";
      },
    },
  });

  assert.equal(result.result.ok, false);
  assert.equal(result.result.status, "blocked");
  assert.deepEqual(Array.from(result.result.fixes), []);
  assert.deepEqual(Array.from(result.result.blockers), [
    "Need production credential from user",
    "User must approve production credential use.",
  ]);
});

test("goal workflow blocks when review consolidation lacks structured output", async () => {
  const result = await runWorkflow(loadWorkflowResource("goal.workflow.js"), {
    persistLogs: false,
    args: { objective: "handle review failure" },
    agent: {
      async run(prompt: string) {
        if (/Create a checkpoint commit/.test(prompt)) {
          return { committed: true, commit: "jkl012", summary: "feat: checkpoint", blockers: [] };
        }
        if (/Strict review consolidator/.test(prompt)) return null;
        if (/Deep goal judge/.test(prompt)) {
          return {
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
        }
        if (/final goal completion summary/.test(prompt)) {
          return {
            summary: "Blocked on review consolidation",
            changedFiles: [],
            commits: ["jkl012"],
            validation: [],
            evidence: [],
            blockers: ["Review consolidation failed"],
            nextAction: "human review required",
          };
        }
        return "review draft";
      },
    },
  });

  assert.equal(result.result.status, "blocked");
  assert.match(result.result.blockers.join("\n"), /Review consolidation failed/);
});

test("parameterized workflow resources inject placeholders before parsing", () => {
  const audit = generateCodebaseAuditWorkflow("src/'quoted'\npath", ["security's edge", "types"]);
  const multi = generateMultiPerspectiveWorkflow("topic with 'quotes'\nand newline", [
    "Security",
    "DX's",
  ]);

  assert.equal(parseWorkflowScript(audit).meta.name, "codebase_audit");
  assert.equal(parseWorkflowScript(multi).meta.name, "multi_perspective_analysis");
  assert.match(audit, /mode: 'fast-review'/);
  assert.match(audit, /mode: 'cheap-review'/);
  assert.match(audit, /mode: "review"/);
  assert.match(audit, /mode: "docs"/);
  assert.match(multi, /mode: 'ask'/);
  assert.match(multi, /mode: "deep"/);
  assert.doesNotMatch(audit, /\{\{scope\}\}/);
  assert.doesNotMatch(multi, /\{\{topic\}\}/);
});

test("workflow template transform leaves unknown placeholders for later injection", () => {
  assert.equal(
    transformWorkflowTemplate("const a = __known__; const b = __later__", { known: "1" }),
    "const a = 1; const b = __later__",
  );
});
