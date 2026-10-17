import { NAME_PATTERN } from "../shared/template";
import type { RenderInput } from "../shared/render";
import { failureText, isSocketUrl, preview, SourceError, sourceSpecSchema, type SourceSpec, specProblems, withDefaults } from "../shared/sources";
import type { Outcome } from "./define";
import { type Library, type Named, readSource, type Scope } from "./library";
import type { SourceRunner } from "./sources";

const PROBE_FRAME_MS = 10_000;
const SAMPLE_CHARS = 400;

const fail = (text: string): Outcome => ({ text, isError: true });
const ok = (text: string): Outcome => ({ text, isError: false });

export interface SourceEnv {
  runner: SourceRunner;
  /** Where the agent works: the test run happens here. */
  cwd: string | undefined;
}

/** A line the agent can paste: how to read or fire this source. */
export function usageLine(name: string, spec: SourceSpec): string {
  if (spec.access === "write") return `Mutation("${name}", {…args}) fired by Button(…, Action([@Run(result)]))`;
  if (spec.mode === "stream") return `data = Query("${name}", {…args}, {…defaults}) (pushed, no interval needed)`;
  return `data = Query("${name}", {…args}, {…defaults}, seconds)`;
}

export function describeSource(name: string, spec: SourceSpec, scope: string, description?: string): string {
  const target = spec.type === "command" ? `$ ${spec.run}` : isSocketUrl(spec.url) ? `WS ${spec.url}` : `${spec.method ?? "GET"} ${spec.url}`;
  const timeout = spec.mode === "stream" ? (spec.timeoutSeconds > 0 ? `idle timeout ${spec.timeoutSeconds}s` : "no idle timeout") : `timeout ${spec.timeoutSeconds}s`;
  return [
    `- ${usageLine(name, spec)} [${scope}] ${spec.mode}, ${spec.access}, ${timeout}${spec.mode === "stream" && spec.window > 1 ? `, last ${spec.window} frames as an array` : ""}${description ? `: ${description}` : ""}`,
    spec.args ? `    args: ${spec.args}` : "",
    spec.returns ? `    returns: ${spec.returns}` : "",
    `    ${preview(target)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function sample(value: unknown): string {
  const text = JSON.stringify(value) ?? "null";
  return text.length > SAMPLE_CHARS ? `${text.slice(0, SAMPLE_CHARS)}…` : text;
}

/** Runs the source once, or until its first frame, so a broken one is never saved. */
async function probe(spec: SourceSpec, args: Record<string, unknown>, name: string, env: SourceEnv): Promise<{ sample: string } | { error: string }> {
  if (!env.cwd) return { error: "This agent has no working directory to test the source in." };
  const context = { cwd: env.cwd, name };
  try {
    if (spec.mode === "once") return { sample: sample(await env.runner.once(spec, args, context)) };
    return await new Promise((resolve) => {
      const frames: unknown[] = [];
      let channel: { stop(): void } | undefined;
      let settled = false;
      const settle = (result: { sample: string } | { error: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        channel?.stop();
        resolve(result);
      };
      const timer = setTimeout(() => settle({ sample: frames.length ? sample(frames[0]) : "(no frame yet, but it is running)" }), PROBE_FRAME_MS);
      env.runner
        .stream(spec, args, context, {
          frame: (value) => {
            frames.push(value);
            settle({ sample: sample(value) });
          },
          end: (failure) => settle(failure ? { error: failureText(failure) } : { sample: frames.length ? sample(frames[0]) : "(the stream ended without a frame)" }),
        })
        .then((opened) => {
          channel = opened;
          if (settled) opened.stop();
        })
        .catch((error: unknown) => settle({ error: error instanceof SourceError ? failureText(error.toFailure()) : String(error) }));
    });
  } catch (error) {
    return { error: error instanceof SourceError ? failureText(error.toFailure()) : String(error) };
  }
}

const IDENTITY_FIELDS = ["type", "run", "url"] as const;

function describeExisting(existing: Named, spec: SourceSpec | undefined): string {
  return [
    `source "${existing.name}" already exists in scope ${existing.scope} (updated ${existing.updatedAt}).`,
    spec ? describeSource(existing.name, spec, existing.scope, existing.description) : "Its saved definition is unreadable.",
  ].join("\n");
}

/** Saves, patches or deletes a source. A read source is test-run first so a broken one is never stored. */
export async function defineSource(library: Library, projectRoot: string | undefined, define: NonNullable<RenderInput["define"]>, env: SourceEnv): Promise<Outcome> {
  const { name, description, overwrite } = define;
  const scope: Scope = define.scope ?? (projectRoot ? "project" : "global");
  if (!NAME_PATTERN.test(name)) return fail("Names start with a letter and use only letters, digits, - and _ (40 max).");
  if (scope === "project" && !projectRoot) return fail("This agent has no project directory. Use scope global.");

  const given = define.source;
  if (given === undefined) {
    if (await library.remove("source", scope, name, projectRoot)) return ok(`Deleted source ${name} from scope ${scope}.`);
    const elsewhere = await library.find("source", scope === "global" ? "project" : "global", name, projectRoot);
    return fail(`No source named ${name} in scope ${scope}.${elsewhere ? ` There is one in scope ${elsewhere.scope}; pass scope: "${elsewhere.scope}" to delete it.` : ""}`);
  }

  const existing = await library.find("source", scope, name, projectRoot);
  const existingRaw = existing ? readSource(existing) : undefined;
  const patching = existing !== undefined && !overwrite && IDENTITY_FIELDS.every((field) => given[field] === undefined);
  if (existing && !overwrite && !patching) {
    return fail(`Not saved: ${describeExisting(existing, existingRaw)}\nQuery it as it is, define yours under another name, or pass overwrite=true if replacing it is what the user wants. To change only timeoutSeconds, window, access, mode or descriptions, pass just those fields.`);
  }
  if (patching && !existingRaw) return fail(`The saved source ${name} is unreadable, so it cannot be patched. Define it again with overwrite=true.`);

  const merged = patching && existingRaw ? { ...existingRaw, ...given } : given;
  const inferred = merged.type ?? (merged.run !== undefined ? "command" : merged.url !== undefined ? "http" : undefined);
  if (!inferred) return fail("A source needs `run` (a command line) or `url`. Pass source: {run: \"…\"} or source: {url: \"https://…\"}.");
  const checked = sourceSpecSchema.safeParse({ ...merged, type: inferred });
  if (!checked.success) return fail(`Not saved. The source definition is invalid:\n- ${checked.error.issues.map((issue) => `${issue.path.join(".") || "source"}: ${issue.message}`).join("\n- ")}`);
  const spec = withDefaults(checked.data);
  const problems = specProblems(spec);
  if (problems.length > 0) return fail(`Not saved. Fix these and define again:\n- ${problems.join("\n- ")}`);

  const args = define.example && typeof define.example === "object" && !Array.isArray(define.example) ? (define.example as Record<string, unknown>) : {};
  const notes: string[] = [];
  let found = "";
  if (patching) {
    notes.push("Patched the saved source; its command was not re-run.");
  } else if (spec.access === "write") {
    notes.push("This source changes things, so it was not test-run. It only runs from a Mutation button.");
  } else {
    const result = await probe(spec, args, name, env);
    if ("error" in result) {
      return fail(`Not saved. The test run failed: ${result.error}\nFix the ${spec.type === "command" ? "command" : "request"}${define.example === undefined ? ", or pass example args if it needs input" : ""} and define it again.`);
    }
    found = `Test run output: ${result.sample}`;
  }

  const saved = await library.save("source", scope, name, { template: JSON.stringify(spec), ...(description ? { description } : {}) }, patching || overwrite === true, projectRoot);
  if (!saved.saved) return fail(`Not saved: ${describeExisting(saved.existing, readSource(saved.existing))}`);
  if (saved.replaced && !patching) notes.push(`Replaced the previous source (updated ${saved.replaced.updatedAt}).`);
  if (saved.shadowed) notes.push(scope === "project" ? "This hides the global source of the same name in this project." : `A ${saved.shadowed.scope} source of the same name still wins in projects that define it.`);
  const text = [
    `Saved source ${name} in scope ${scope}: ${spec.mode}, ${spec.access}, ${spec.mode === "stream" ? (spec.timeoutSeconds > 0 ? `idle timeout ${spec.timeoutSeconds}s` : "no idle timeout") : `timeout ${spec.timeoutSeconds}s`}.`,
    `Use it as ${usageLine(name, spec)}.`,
    found,
    ...notes,
  ]
    .filter(Boolean)
    .join("\n");
  return ok(text);
}
