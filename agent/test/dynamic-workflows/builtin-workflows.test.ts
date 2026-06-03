import assert from "node:assert/strict";
import { test } from "vitest";
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
import { parseWorkflowScript } from "../../src/extensions/dynamic-workflows/workflow.js";

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

test("simplify workflow produces a valid, parseable script", () => {
  const { meta, body } = parseWorkflowScript(generateSimplifyWorkflow());
  assert.equal(meta.name, "simplify");
  assert.deepEqual(
    meta.phases?.map((phase) => phase.title),
    ["Code Review", "Fix Issues"],
  );
  assert.match(body, /reuse-review/);
  assert.match(body, /quality-review/);
  assert.match(body, /efficiency-review/);
  assert.match(body, /simplify-fixer/);
});

test("workflow resources start with exported metadata", () => {
  for (const resourceName of [
    "adversarial-review.workflow.js",
    "auto-generated.workflow.js",
    "codebase-audit.workflow.js",
    "deep-research.workflow.js",
    "multi-perspective.workflow.js",
    "simplify.workflow.js",
  ]) {
    assert.match(loadWorkflowResource(resourceName), /^export const meta = /);
  }
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
