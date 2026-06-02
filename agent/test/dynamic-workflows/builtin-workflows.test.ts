import assert from "node:assert/strict";
import { test } from "vitest";
import { generateAdversarialReviewWorkflow } from "../../src/extensions/dynamic-workflows/adversarial-review.js";
import { generateDeepResearchWorkflow } from "../../src/extensions/dynamic-workflows/deep-research.js";
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
  // Uses the agreement threshold to decide survivors.
  assert.match(body, /threshold/);
  assert.match(body, /survives/);
});
