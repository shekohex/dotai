import { expandUi, NAME_PATTERN, templateProps } from "../shared/template";
import type { RenderInput } from "../shared/render";
import { checkUi } from "./guide";
import { defineSource, type SourceEnv } from "./define-source";
import type { Library, Named, Scope } from "./library";

type Kind = "component" | "program";

export interface Outcome {
  text: string;
  isError: boolean;
}

const PREVIEW_CHARS = 500;

const fail = (text: string): Outcome => ({ text, isError: true });
const ok = (text: string): Outcome => ({ text, isError: false });

function usage(kind: Kind, name: string): string {
  return kind === "program" ? `@Run("${name}", {props}) as the whole ui` : `@Use("${name}", {props}) inside a program`;
}

function describeExisting(kind: Kind, existing: Named): string {
  const props = templateProps(existing.template);
  const preview = existing.template.length > PREVIEW_CHARS ? `${existing.template.slice(0, PREVIEW_CHARS)}…` : existing.template;
  return [
    `${kind} "${existing.name}" already exists in scope ${existing.scope} (updated ${existing.updatedAt})${existing.description ? `: ${existing.description}` : ""}.`,
    props.length ? `Props: ${props.join(", ")}.` : "It takes no props.",
    `Template:\n${preview}`,
  ].join("\n");
}

/** Saves, replaces or deletes a reusable component or program, testing the template with the example first. */
export async function defineEntry(library: Library, projectRoot: string | undefined, define: NonNullable<RenderInput["define"]>, sources: SourceEnv): Promise<Outcome> {
  if (define.kind === "source") return defineSource(library, projectRoot, define, sources);
  const { name, template, description, example, overwrite } = define;
  const kind: Kind = define.kind ?? "component";
  const scope: Scope = define.scope ?? (projectRoot ? "project" : "global");
  if (!NAME_PATTERN.test(name)) return fail("Names start with a letter and use only letters, digits, - and _ (40 max).");
  if (scope === "project" && !projectRoot) return fail("This agent has no project directory. Use scope global.");

  if (template === undefined || template.trim() === "") {
    if (await library.remove(kind, scope, name, projectRoot)) return ok(`Deleted ${kind} ${name} from scope ${scope}.`);
    const elsewhere = await library.find(kind, scope === "global" ? "project" : "global", name, projectRoot);
    return fail(`No ${kind} named ${name} in scope ${scope}.${elsewhere ? ` There is one in scope ${elsewhere.scope}; pass scope: "${elsewhere.scope}" to delete it.` : ""}`);
  }

  const snapshot = await library.snapshot(projectRoot);
  const own = { component: (wanted: string) => (kind === "component" && wanted === name ? template : snapshot.templates.component(wanted)), program: (wanted: string) => (kind === "program" && wanted === name ? template : snapshot.templates.program(wanted)) };
  const props = JSON.stringify(example ?? {});
  const test = expandUi(kind === "program" ? `@Run("${name}", ${props})` : `root = @Use("${name}", ${props})`, own);
  if (test.errors.length > 0) return fail(`Not saved. Fix these and define again:\n- ${test.errors.join("\n- ")}`);
  if (kind === "program" && example === undefined && !/^\s*root\s*=/m.test(template)) {
    return fail("Not saved. A program needs a `root = ...` statement.");
  }
  if (example !== undefined) {
    const report = checkUi(test.ui);
    if (report.errors.length > 0) return fail(`Not saved. The example does not render:\n- ${report.errors.join("\n- ")}`);
  }

  const result = await library.save(kind, scope, name, { template, ...(description ? { description } : {}) }, overwrite === true, projectRoot);
  if (!result.saved) {
    return fail(
      `Not saved: ${describeExisting(kind, result.existing)}\nReuse it with ${usage(kind, name)}, define yours under another name, or pass overwrite=true if replacing it is what the user wants.`,
    );
  }
  const notes = [
    result.replaced ? `Replaced the previous ${kind} (it had updated ${result.replaced.updatedAt}).` : "",
    result.shadowed
      ? scope === "project"
        ? `This hides the global ${kind} of the same name in this project.`
        : `A ${result.shadowed.scope} ${kind} of the same name still wins in projects that define it.`
      : "",
    example === undefined ? "No example was given, so the template was not test-rendered." : "",
  ].filter(Boolean);
  const used = templateProps(template);
  return ok(`Saved ${kind} ${name} in scope ${scope}${used.length ? ` (props: ${used.join(", ")})` : ""}. Use it as ${usage(kind, name)}, or in an openui block.${notes.length ? `\n${notes.join("\n")}` : ""}`);
}
