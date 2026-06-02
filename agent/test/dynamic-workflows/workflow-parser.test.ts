import assert from "node:assert/strict";
import { test } from "vitest";
import { parseWorkflowScript } from "../../src/extensions/dynamic-workflows/workflow.js";

const validScript = `export const meta = {
  name: 'demo_workflow',
  description: 'A useful workflow',
  whenToUse: 'When testing parser behavior',
  phases: [{ title: 'Scan', detail: 'Collect inputs', mode: 'search' }]
}

phase('Scan')
return { ok: true }
`;

test("parseWorkflowScript accepts literal workflow metadata", () => {
  const parsed = parseWorkflowScript(validScript);
  assert.equal(parsed.meta.name, "demo_workflow");
  assert.equal(parsed.meta.description, "A useful workflow");
  assert.deepEqual(parsed.meta.phases, [
    { title: "Scan", detail: "Collect inputs", mode: "search" },
  ]);
  assert.match(parsed.body, /phase\('Scan'\)/);
  assert.doesNotMatch(parsed.body, /export const meta/);
});

test("parseWorkflowScript accepts static template literals", () => {
  const parsed = parseWorkflowScript(
    "export const meta = { name: `demo`, description: `static` }\nreturn true",
  );
  assert.equal(parsed.meta.name, "demo");
  assert.equal(parsed.meta.description, "static");
});

test("parseWorkflowScript requires meta export first", () => {
  assert.throws(
    () =>
      parseWorkflowScript("const x = 1\nexport const meta = { name: 'demo', description: 'desc' }"),
    /must be the first statement/,
  );
});

test("parseWorkflowScript requires name and description", () => {
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: 'demo' }"),
    /meta.description/,
  );
  assert.throws(
    () => parseWorkflowScript("export const meta = { description: 'desc' }"),
    /meta.name/,
  );
});

test("parseWorkflowScript rejects non-literal metadata", () => {
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: makeName(), description: 'desc' }"),
    /non-literal node type.*CallExpression/,
  );
  assert.throws(
    () =>
      parseWorkflowScript("const name = 'demo'; export const meta = { name, description: 'desc' }"),
    /must be the first statement/,
  );
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: name, description: 'desc' }"),
    /non-literal node type.*Identifier/,
  );
});

test("parseWorkflowScript rejects object hazards", () => {
  assert.throws(
    () => parseWorkflowScript("export const meta = { ...base, name: 'demo', description: 'desc' }"),
    /spread not allowed/,
  );
  assert.throws(
    () => parseWorkflowScript("export const meta = { ['name']: 'demo', description: 'desc' }"),
    /computed keys not allowed/,
  );
  assert.throws(
    () =>
      parseWorkflowScript(
        "export const meta = { __proto__: {}, name: 'demo', description: 'desc' }",
      ),
    /reserved key name/,
  );
  assert.throws(
    () =>
      parseWorkflowScript(
        "export const meta = { get name() { return 'demo' }, description: 'desc' }",
      ),
    /methods\/accessors not allowed/,
  );
});

test("parseWorkflowScript rejects array hazards", () => {
  assert.throws(
    () =>
      parseWorkflowScript(
        "export const meta = { name: 'demo', description: 'desc', phases: [,,] }",
      ),
    /sparse arrays not allowed/,
  );
  assert.throws(
    () =>
      parseWorkflowScript(
        "export const meta = { name: 'demo', description: 'desc', phases: [...items] }",
      ),
    /spread not allowed/,
  );
});

test("parseWorkflowScript rejects template interpolation", () => {
  assert.throws(
    () =>
      parseWorkflowScript("export const meta = { name: `demo_$" + "{id}`, description: 'desc' }"),
    /template interpolation not allowed/,
  );
});

test("parseWorkflowScript rejects nondeterministic APIs", () => {
  assert.throws(
    () =>
      parseWorkflowScript(
        "export const meta = { name: 'demo', description: 'desc' }\nreturn Date.now()",
      ),
    /must be deterministic/,
  );
  assert.throws(
    () =>
      parseWorkflowScript(
        "export const meta = { name: 'demo', description: 'desc' }\nreturn Math.random()",
      ),
    /must be deterministic/,
  );
  assert.throws(
    () =>
      parseWorkflowScript(
        "export const meta = { name: 'demo', description: 'desc' }\nreturn new Date()",
      ),
    /must be deterministic/,
  );
});
