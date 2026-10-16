import { createParser } from "../shared/lang-core/index.mjs";
import { templateProps } from "../shared/template";
import type { Named, Snapshot } from "./library";
import { FENCE_OPTIONS, GUIDE_OPTIONS, library } from "../shared/library";

const cachedGuides = new Map<GuideMode, string>();

export type GuideMode = "tool" | "fence";

/** The full syntax and component reference, generated from the same library the app renders. */
export function guideText(mode: GuideMode = "tool"): string {
  const options = mode === "fence" ? FENCE_OPTIONS : GUIDE_OPTIONS;
  let guide = cachedGuides.get(mode);
  if (guide === undefined) {
    guide = library.prompt({ ...options, additionalRules: [...options.additionalRules] });
    cachedGuides.set(mode, guide);
  }
  return guide;
}

const parser = createParser(library.toJSONSchema(), library.root);

export interface UiReport {
  /** Problems that drop part of the UI; the agent should fix and render again. */
  errors: string[];
  /** Things that silently do not render, such as a statement nothing references. */
  warnings: string[];
}

export function checkUi(ui: string): UiReport {
  const result = parser.parse(ui);
  const errors = result.meta.errors
    .filter((error) => error.severity !== "warning")
    .map((error) => `${error.statementId ? `${error.statementId}: ` : ""}${error.message}`);
  const warnings = result.meta.errors
    .filter((error) => error.severity === "warning")
    .map((error) => error.message);
  if (!result.root && !result.rootExpression && errors.length === 0) {
    errors.push("No root. Define `root = Stack([...])`.");
  }
  if (result.meta.unresolved.length > 0) {
    errors.push(`Undefined names: ${result.meta.unresolved.join(", ")}. Define each one or remove the reference.`);
  }
  if (result.meta.orphaned.length > 0) {
    warnings.push(
      `Defined but never used, so not shown: ${result.meta.orphaned.join(", ")}. Reference them from root or remove them.`,
    );
  }
  return { errors, warnings };
}

const COMPONENT_RULES = `## Reusable components and programs
A saved component is one OpenUI expression with {{prop}} holes. Use it anywhere an expression goes:
  root = Stack([@Use("metric", {label: "Latency", value: "120 ms"}), @Use("metric", {label: "Errors", value: "0.2%"})])
A saved program is a whole program (statements ending in root = ...) with the same holes. Use it as the entire ui; its props are handed on to the components nested inside it:
  @Run("service-board", {title: "Prod", services: [{name: "api", latency: 120}, {name: "web", latency: 80}]})
Props are JSON-like ({key: value}, strings, numbers, booleans, arrays, objects). Where a hole is a whole argument it becomes that value, so {{rows}} can carry an array of objects. Inside a quoted string it is inserted as text: "Hello {{name}}".
Read a nested value with {{user.name}}. Repeat with {{#each rows}}Row("{{this.label}}", {{@index}}){{/each}}; the copies are joined with commas, so put it inside [ ] or an argument list. Use {{this}} for a scalar item.
Components may use other components, and programs may use components. Every @Use is expanded before the program is read, so statement names inside a component template must not repeat; prefer one expression with inline children.`;

const DEFINE_RULES = `Save one with render({define: {name, kind, scope, template, description, example}}). kind is component (default) or program. scope is project (default: saved in this project's .paseo/openui/, visible to agents working here, safe to commit) or global (every project). A project definition wins over a global one of the same name. Pass example props so it is test-rendered first. An existing name in the same scope is never replaced silently: you get the existing definition back, so reuse it, pick another name, or pass overwrite=true when you own it. render({define: {name, kind, scope}}) without a template deletes it.`;

export function componentsText(snapshot: Snapshot, canDefine: boolean): string {
  const describe = (items: Map<string, Named>, call: string) =>
    items.size === 0
      ? ["- (none saved yet)"]
      : [...items.values()].map((one) => {
          const props = templateProps(one.template);
          return `- ${call}("${one.name}"${props.length ? `, {${props.join(", ")}}` : ""}) [${one.scope}]${one.description ? `: ${one.description}` : ""}`;
        });
  return [
    COMPONENT_RULES,
    canDefine ? DEFINE_RULES : "",
    "Saved components:",
    ...describe(snapshot.components, "@Use"),
    "Saved programs:",
    ...describe(snapshot.programs, "@Run"),
  ]
    .filter(Boolean)
    .join("\n");
}
