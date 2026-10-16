/**
 * Reusable UI for OpenUI Lang, which has no parameterized components of its own.
 * A saved component is an OpenUI expression with `{{prop}}` holes; `@Use("name", {props})` in a
 * program is replaced by the filled template before the program is parsed.
 * A saved program is a whole multi-statement program with the same holes; a program that is
 * exactly `@Run("name", {props})` is replaced by the filled program. Props reach the components
 * nested inside because holes are filled before nested `@Use` calls are expanded.
 */

export const USE_CALL = "@Use(";
export const RUN_CALL = "@Run(";
export const MAX_NESTING = 4;
export const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;

export type Lookup = (name: string) => string | undefined;

/** Saved templates by name: components for `@Use`, programs for `@Run`. */
export interface Library {
  component: Lookup;
  program: Lookup;
}

export interface Expansion {
  ui: string;
  errors: string[];
}

export function usesComponents(ui: string): boolean {
  return ui.includes(USE_CALL) || ui.includes(RUN_CALL);
}

/** Props are written in OpenUI object syntax: JSON, plus unquoted keys, single quotes and trailing commas. */
export function parseLiteral(text: string): unknown {
  let index = 0;
  const fail = (message: string): never => {
    throw new Error(`${message} at ${index} in props`);
  };
  const skip = () => {
    while (index < text.length && /\s/.test(text[index] as string)) index += 1;
  };
  const string = (): string => {
    const quote = text[index] as string;
    let out = "";
    index += 1;
    while (index < text.length && text[index] !== quote) {
      if (text[index] === "\\") {
        const next = text[index + 1] ?? "";
        if (next === "u") {
          out += String.fromCharCode(Number.parseInt(text.slice(index + 2, index + 6), 16));
          index += 6;
          continue;
        }
        out += ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" } as Record<string, string>)[next] ?? next;
        index += 2;
        continue;
      }
      out += text[index];
      index += 1;
    }
    if (index >= text.length) fail("Unterminated string");
    index += 1;
    return out;
  };
  const value = (): unknown => {
    skip();
    const char = text[index];
    if (char === '"' || char === "'") return string();
    if (char === "[") {
      index += 1;
      const list: unknown[] = [];
      for (;;) {
        skip();
        if (text[index] === "]") break;
        list.push(value());
        skip();
        if (text[index] === ",") index += 1;
        else if (text[index] !== "]") fail("Expected , or ]");
      }
      index += 1;
      return list;
    }
    if (char === "{") {
      index += 1;
      const record: Record<string, unknown> = {};
      for (;;) {
        skip();
        if (text[index] === "}") break;
        const quote = text[index];
        const key =
          quote === '"' || quote === "'" ? string() : (/^[A-Za-z_$][\w$-]*/.exec(text.slice(index))?.[0] ?? fail("Expected a key"));
        if (quote !== '"' && quote !== "'") index += key.length;
        skip();
        if (text[index] !== ":") fail("Expected :");
        index += 1;
        record[key] = value();
        skip();
        if (text[index] === ",") index += 1;
        else if (text[index] !== "}") fail("Expected , or }");
      }
      index += 1;
      return record;
    }
    const word = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(index))?.[0];
    if (word === undefined) return fail("Unexpected value");
    index += word.length;
    return word === "true" ? true : word === "false" ? false : word === "null" ? null : Number(word);
  };
  const result = value();
  skip();
  if (index < text.length) fail("Unexpected text");
  return result;
}

interface Scope {
  props: unknown;
  item?: unknown;
  index?: number;
}

function resolve(path: string, scope: Scope): { found: boolean; value: unknown } {
  const segments = path.split(".");
  let current: unknown;
  if (path === "@index") return { found: scope.index !== undefined, value: scope.index };
  if (segments[0] === "this") {
    if (scope.item === undefined) return { found: false, value: undefined };
    current = scope.item;
    segments.shift();
  } else {
    current = scope.props;
  }
  for (const segment of segments) {
    if (current === null || typeof current !== "object" || !(segment in current)) return { found: false, value: undefined };
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

function encode(value: unknown, inString: boolean): string {
  const json = JSON.stringify(value) ?? "null";
  if (!inString) return json;
  return typeof value === "string" ? json.slice(1, -1) : json.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function eachEnd(template: string, from: number): { close: number; after: number } | null {
  let depth = 1;
  const tag = /\{\{\s*(#each\b|\/each)[^}]*\}\}/g;
  tag.lastIndex = from;
  for (let match = tag.exec(template); match; match = tag.exec(template)) {
    depth += match[1] === "/each" ? -1 : 1;
    if (depth === 0) return { close: match.index, after: tag.lastIndex };
  }
  return null;
}

/**
 * Fills `{{path}}` holes (a value is written as an OpenUI literal, or as bare text inside a string
 * in the template) and repeats `{{#each path}}…{{/each}}`, joined with commas.
 */
export function fillTemplate(template: string, props: unknown, errors: string[] = []): string {
  const run = (source: string, scope: Scope, startsInString: boolean): string => {
    let out = "";
    let inString = startsInString;
    let index = 0;
    while (index < source.length) {
      const char = source[index] as string;
      if (char === "{" && source[index + 1] === "{") {
        const end = source.indexOf("}}", index);
        if (end < 0) break;
        const tag = source.slice(index + 2, end).trim();
        index = end + 2;
        if (tag.startsWith("#each")) {
          const path = tag.slice(5).trim();
          const block = eachEnd(source, index);
          if (!block) {
            errors.push(`{{#each ${path}}} has no {{/each}}`);
            continue;
          }
          const body = source.slice(index, block.close);
          const list = resolve(path, scope);
          if (!list.found || !Array.isArray(list.value)) errors.push(`{{#each ${path}}} needs an array prop`);
          else
            out += list.value.map((item, position) => run(body, { props: scope.props, item, index: position }, inString)).join(", ");
          index = block.after;
        } else if (tag.startsWith("/")) {
          errors.push(`Stray {{${tag}}}`);
        } else {
          const found = resolve(tag, scope);
          if (!found.found) errors.push(`Missing prop "${tag}"`);
          out += encode(found.found ? found.value : null, inString);
        }
        continue;
      }
      if (char === "\\" && inString) {
        out += char + (source[index + 1] ?? "");
        index += 2;
        continue;
      }
      if (char === '"') inString = !inString;
      out += char;
      index += 1;
    }
    return out;
  };
  return run(template, { props }, false);
}

/** Index just past the `)` matching the `(` at `open`, skipping strings; -1 when unbalanced. */
function closingParen(text: string, open: number): number {
  let depth = 0;
  let quote = "";
  for (let index = open; index < text.length; index += 1) {
    const char = text[index] as string;
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")" && --depth === 0) return index + 1;
  }
  return -1;
}

/** Splits `"name", {props}` on the first top-level comma. */
function splitCall(args: string): [string, string] {
  let quote = "";
  for (let index = 0; index < args.length; index += 1) {
    const char = args[index] as string;
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === ",") return [args.slice(0, index), args.slice(index + 1)];
  }
  return [args, ""];
}

/** Replaces `@Run("name", {props})` (the whole program) and every `@Use("name", {props})` with the saved templates filled with those props. */
export function expandUi(ui: string, library: Library, depth = 0): Expansion {
  if (!usesComponents(ui)) return { ui, errors: [] };
  const trimmed = ui.trim();
  if (trimmed.startsWith(RUN_CALL)) return runProgram(trimmed, library, depth);
  const errors: string[] = [];
  let out = "";
  let quote = "";
  let index = 0;
  while (index < ui.length) {
    const char = ui[index] as string;
    if (quote) {
      if (char === "\\") {
        out += char + (ui[index + 1] ?? "");
        index += 2;
        continue;
      }
      if (char === quote) quote = "";
    } else if (char === '"') quote = char;
    else if (ui.startsWith(USE_CALL, index)) {
      const end = closingParen(ui, index + USE_CALL.length - 1);
      if (end < 0) {
        errors.push("@Use( is missing its closing )");
        out += ui.slice(index);
        break;
      }
      out += useOne(ui.slice(index + USE_CALL.length, end - 1), library, depth, errors);
      index = end;
      continue;
    }
    out += char;
    index += 1;
  }
  return { ui: out, errors };
}

function parseCall(args: string): { name: string; props: unknown } | string {
  const [rawName, rawProps] = splitCall(args);
  try {
    const name = parseLiteral(rawName);
    const props = rawProps.trim() === "" ? {} : parseLiteral(rawProps);
    if (typeof name !== "string") return 'The component name must be a string, like @Use("name", {props})';
    return { name, props };
  } catch (error) {
    return `(${args.slice(0, 40)}…): ${error instanceof Error ? error.message : String(error)}`;
  }
}

function instantiate(kind: "component" | "program", args: string, library: Library, depth: number, errors: string[]): string | null {
  const call = parseCall(args);
  if (typeof call === "string") {
    errors.push(`@${kind === "component" ? "Use" : "Run"}${call}`);
    return null;
  }
  const template = (kind === "component" ? library.component : library.program)(call.name);
  if (template === undefined) {
    errors.push(`Unknown ${kind} "${call.name}"`);
    return null;
  }
  if (depth >= MAX_NESTING) {
    errors.push(`${kind === "component" ? "Component" : "Program"} "${call.name}" nests too deep (does it use itself?)`);
    return null;
  }
  const own: string[] = [];
  const filled = fillTemplate(template, call.props, own);
  errors.push(...own.map((message) => `${call.name}: ${message}`));
  const nested = expandUi(filled, library, depth + 1);
  errors.push(...nested.errors);
  return nested.ui;
}

function useOne(args: string, library: Library, depth: number, errors: string[]): string {
  return instantiate("component", args, library, depth, errors) ?? "null";
}

function runProgram(program: string, library: Library, depth: number): Expansion {
  const end = closingParen(program, RUN_CALL.length - 1);
  if (end < 0) return { ui: program, errors: ["@Run( is missing its closing )"] };
  if (program.slice(end).trim() !== "") return { ui: program, errors: ["@Run(...) must be the whole program: put nothing after it"] };
  const errors: string[] = [];
  const ui = instantiate("program", program.slice(RUN_CALL.length, end - 1), library, depth, errors);
  return { ui: ui ?? "", errors };
}

/** Prop paths a template reads, such as `title` or `rows[].label`, for the agent's confirmation. */
export function templateProps(template: string): string[] {
  const found = new Set<string>();
  const loops: string[] = [];
  const tag = /\{\{\s*([^}]*?)\s*\}\}/g;
  for (let match = tag.exec(template); match; match = tag.exec(template)) {
    const body = match[1] as string;
    if (body.startsWith("#each")) {
      const path = body.slice(5).trim();
      loops.push(path);
      found.add(`${path}[]`);
    }
    else if (body.startsWith("/each")) loops.pop();
    else if (body === "@index" || body === "this") continue;
    else if (body.startsWith("this.")) {
      const parent = loops[loops.length - 1];
      if (parent) found.add(`${parent}[].${body.slice(5)}`);
    } else found.add(body);
  }
  return [...found];
}
