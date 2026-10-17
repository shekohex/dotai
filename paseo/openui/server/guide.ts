import { createParser } from "../shared/lang-core/index.mjs";
import { templateProps } from "../shared/template";
import type { SourceSpec } from "../shared/sources";
import { describeSource } from "./define-source";
import { type Named, readSource, type Snapshot } from "./library";
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

/** The sources an agent can read, by name; undefined marks a saved file that no longer parses. */
export type SourceIndex = ReadonlyMap<string, SourceSpec | undefined>;

export function sourceIndex(snapshot: Snapshot): SourceIndex {
  return new Map([...snapshot.sources].map(([name, named]) => [name, readSource(named)]));
}

const MIN_REFRESH_SECONDS = 0.5;

function literal(node: { k?: string; v?: unknown } | null | undefined): string | number | undefined {
  return node && (node.k === "Str" || node.k === "Num") ? (node.v as string | number) : undefined;
}

/** Problems with the Query and Mutation calls of a program, judged against the sources the agent has saved. */
function checkSources(result: ReturnType<typeof parser.parse>, sources: SourceIndex, errors: string[], warnings: string[]): void {
  const known = [...sources.keys()];
  const calls = [
    ...result.queryStatements.map((call) => ({ call, kind: "Query" as const })),
    ...result.mutationStatements.map((call) => ({ call, kind: "Mutation" as const })),
  ];
  for (const { call, kind } of calls) {
    const name = literal(call.toolAST as { k?: string; v?: unknown } | null);
    if (typeof name !== "string") {
      errors.push(`${call.statementId}: the first argument of ${kind} must be a quoted source name, like ${kind}("sys_stats", {}).`);
      continue;
    }
    if (!sources.has(name)) {
      errors.push(
        `${call.statementId}: no source named "${name}". ${known.length ? `Saved sources: ${known.join(", ")}.` : "No sources are saved for this agent yet."} Define it first with render({define: {kind: "source", name: "${name}", source: {run: "…"}}}).`,
      );
      continue;
    }
    const spec = sources.get(name);
    if (!spec) {
      errors.push(`${call.statementId}: the saved source "${name}" cannot be read. Define it again with overwrite=true.`);
      continue;
    }
    if (kind === "Query" && spec.access === "write") {
      errors.push(`${call.statementId}: "${name}" changes things, so it cannot be a Query that runs by itself. Use Mutation and fire it from a Button.`);
    }
    if (kind === "Mutation" && spec.mode === "stream") {
      errors.push(`${call.statementId}: "${name}" is a stream. Read it with Query; Mutation runs a source once.`);
    }
    if (kind === "Query") {
      const refresh = literal((call as { refreshAST?: { k?: string; v?: unknown } | null }).refreshAST);
      if (spec.mode === "stream" && refresh !== undefined) warnings.push(`${call.statementId}: "${name}" is a stream and pushes its own updates, so the refresh interval is ignored.`);
      if (typeof refresh === "number" && refresh > 0 && refresh < MIN_REFRESH_SECONDS) warnings.push(`${call.statementId}: refresh below ${MIN_REFRESH_SECONDS}s is raised to ${MIN_REFRESH_SECONDS}s.`);
    }
  }
}

export function checkUi(ui: string, sources?: SourceIndex): UiReport {
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
  if (sources) checkSources(result, sources, errors, warnings);
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

export const SOURCE_EXAMPLE = `$live = true
$every = "5"
stats = Query("sys_stats", {}, {cpu: 0, mem: 0, load: [0, 0, 0]}, $live ? $every : 0)
root = Stack([Switch("live", "Live", $live), Select("every", ["1", "5", "10", "30"], "Refresh every (seconds)", $every), Gauge(stats.cpu, 100, "CPU", "%"), Sparkline(stats.load, "Load")])`;

const SOURCE_RULES = `## Live data and actions: sources
A source is a command or a URL that the app runs for you; the UI reads its JSON. Use it when the user wants live numbers, polling, a refresh button, or a form that does something. Never hardcode data that should stay live. Use only the sources listed under Saved sources below; a name that is not saved fails.
${SOURCE_EXAMPLE.split("\n").map((line) => `  ${line}`).join("\n")}
- Query(source, args, defaults, seconds?) shows the defaults at once, then the real data. Read fields with dot access: stats.cpu, stats.rows (use @Each over arrays). args may hold $variables; when one changes the Query re-reads. seconds may be a $variable or an expression of them, so the user can change the cadence or pause it (0 pauses); the least is 0.5. Option lists of Select, RadioGroup and the like must be strings, so keep such a $variable a string like "5".
- A source with mode stream pushes: no interval needed, the UI updates as lines arrive (near real time). With window N the Query result is an array of the last N frames, oldest first, handy for Sparkline and LineChart; with the default window 1 it is the latest frame.
- Mutation(source, args) does something when a button fires it: save = Mutation("deploy", {env: $env}) and Button("Deploy", Action([@Run(save), @Run(stats)]), "primary") runs it, then re-reads stats. save.status is idle, loading, success or error; save.data is the result; save.error the message. A source that changes anything must be access write so it only ever runs from a button. Collect Mutation args in $variables bound to inputs.
- Add a Button("Refresh", Action([@Run(stats)])) for a manual read. The app shows a source's failure to the user by itself and keeps the last good data on screen; show save.status yourself.
- What a source prints: one JSON value on stdout (a command exits 0), or for a stream one JSON value per line (NDJSON, or SSE data: lines; data: [DONE] ends it). A JSON-RPC reply {"jsonrpc":"2.0","result":…} is unwrapped. It receives {"args": {...}} as one JSON line on stdin and in $OPENUI_ARGS; never build the command line from args. Print only what the UI shows (1 MB max).`;

const DEFINE_SOURCE_RULES = `Save a source with render({define: {name, kind: "source", scope, description, example, source: {…}}}). Write the script yourself first (a bash, python or node file, for example in .paseo/openui/scripts/), then point run at it: source: {run: "bash .paseo/openui/scripts/stats.sh"}. It runs from your working directory. For a URL: source: {url: "https://api.example.com/users/{id}", method, headers, query, body}; {id} is filled from args, other args go in the query of a GET or the JSON body otherwise, ${"$"}{TOKEN} in headers, query and url is filled from the daemon's environment so no secret is saved. A ws:// or wss:// url is a WebSocket: each message is a frame, body (merged with args) is sent on open. The source is test-run when you define it (with example as args) and is not saved if it fails; a failure tells you why.
Fields: mode once (default; one JSON value per call) or stream. timeoutSeconds: for once the most it may run (default 10, max 3600, so give slow commands more); for stream the most silence between lines (default 30; 0 = never). window (stream): keep the last N frames. access read (default) or write. args and returns: one line each describing the input and the JSON shape, shown to anyone who reads this guide. To change just a timeout, window, access or description later, pass only those fields for the same name. Other changes need overwrite=true; an existing name is never replaced silently. Delete with render({define: {name, kind: "source"}}). scope works as for components.`;

export function componentsText(snapshot: Snapshot, canDefine: boolean): string {
  const describe = (items: Map<string, Named>, call: string) =>
    items.size === 0
      ? ["- (none saved yet)"]
      : [...items.values()].map((one) => {
          const props = templateProps(one.template);
          return `- ${call}("${one.name}"${props.length ? `, {${props.join(", ")}}` : ""}) [${one.scope}]${one.description ? `: ${one.description}` : ""}`;
        });
  const sources = [...snapshot.sources.values()].map((named) => {
    const spec = readSource(named);
    return spec ? describeSource(named.name, spec, named.scope, named.description) : `- ${named.name} [${named.scope}] (unreadable: define it again with overwrite=true)`;
  });
  return [
    COMPONENT_RULES,
    canDefine ? DEFINE_RULES : "",
    "Saved components:",
    ...describe(snapshot.components, "@Use"),
    "Saved programs:",
    ...describe(snapshot.programs, "@Run"),
    SOURCE_RULES,
    canDefine ? DEFINE_SOURCE_RULES : "",
    "Saved sources:",
    ...(sources.length ? sources : ["- (none saved yet)"]),
  ]
    .filter(Boolean)
    .join("\n");
}
