import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const WorkflowTemplateValuesSchema = Type.Record(Type.String(), Type.String());

type WorkflowTemplateValues = Static<typeof WorkflowTemplateValuesSchema>;

export const workflowResourcesDir = join(
  import.meta.dirname,
  "..",
  "..",
  "resources",
  "workflows",
  "dynamic",
);

/**
 * Load a bundled workflow resource script.
 *
 * Bundled workflow resources are real JavaScript workflow scripts whose first statement must be
 * `export const meta = ...`, matching `parseWorkflowScript` requirements.
 *
 * @param {string} name Resource filename under `src/resources/workflows/dynamic`.
 * @returns {string} Raw workflow script ready for template transformation or parsing.
 */
export function loadWorkflowResource(name: string): string {
  return readFileSync(join(workflowResourcesDir, name), "utf-8");
}

/**
 * Load and transform a bundled workflow resource.
 *
 * Workflow template variables use sentinel identifiers: `__x__` is replaced by `values.x` before
 * `parseWorkflowScript` runs. Values must be valid JavaScript source snippets, for example
 * `JSON.stringify(value)` for string literals or `[() => agent(...)]` for generated arrays. Unknown
 * sentinels are left unchanged so partial transforms remain possible.
 *
 * @param {string} name Resource filename under `src/resources/workflows/dynamic`.
 * @param {WorkflowTemplateValues} values Sentinel replacement values keyed without underscores.
 * @returns {string} Transformed workflow script.
 */
export function renderWorkflowResource(name: string, values: WorkflowTemplateValues = {}): string {
  if (!Value.Check(WorkflowTemplateValuesSchema, values)) {
    throw new TypeError("workflow template values must be string key/value pairs");
  }

  return transformWorkflowTemplate(loadWorkflowResource(name), values);
}

export function transformWorkflowTemplate(
  template: string,
  values: WorkflowTemplateValues,
): string {
  return template.replaceAll(
    /\b__([a-zA-Z][a-zA-Z0-9_]*)__\b/g,
    (match, key: string) => values[key] ?? match,
  );
}

export function jsString(value: string): string {
  return JSON.stringify(value);
}
