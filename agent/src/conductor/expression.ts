import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

import { isRecord, readString } from "../utils/unknown-data.js";

type Token =
  | { type: "identifier"; value: string }
  | { type: "string"; value: string }
  | { type: "number"; value: number }
  | { type: "operator"; value: "&&" | "||" | "==" | "!=" | "!" | ">" | ">=" | "<" | "<=" }
  | { type: "punctuation"; value: "." | "(" | ")" | "," | "[" | "]" | "*" };

type ExpressionContext = Record<string, unknown>;
type OperatorTokenValue = Extract<Token, { type: "operator" }>["value"];
type PunctuationTokenValue = Extract<Token, { type: "punctuation" }>["value"];
type PathSegment = string | number;

export function evaluateWrappedExpression(expression: string, context: ExpressionContext): unknown {
  const inner = unwrapExpression(expression, true);
  return new Parser(tokenize(inner), context).parse();
}

export function evaluateCondition(
  expression: string | undefined,
  context: ExpressionContext,
): boolean {
  if (expression === undefined || expression.trim().length === 0) return true;
  return toBoolean(new Parser(tokenize(unwrapExpression(expression, false)), context).parse());
}

export function renderTemplate(template: string, context: ExpressionContext): string {
  return template.replaceAll(/\$\{\{([\s\S]*?)\}\}/g, (_match, expression: string) => {
    const value = new Parser(tokenize(expression.trim()), context).parse();
    if (value === undefined) {
      throw new Error(`Missing expression value: ${expression.trim()}`);
    }
    return valueToString(value);
  });
}

function unwrapExpression(expression: string, requireWrapper: boolean): string {
  const trimmed = expression.trim();
  if (!trimmed.startsWith("${{") || !trimmed.endsWith("}}")) {
    if (!requireWrapper) return trimmed;
    throw new Error(`Expression must be wrapped with \${{ ... }}: ${expression}`);
  }
  return trimmed.slice(3, -2).trim();
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < input.length) {
    const char = input[index];
    if (char === undefined) break;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      const parsed = readStringToken(input, index, char);
      tokens.push({ type: "string", value: parsed.value });
      index = parsed.nextIndex;
      continue;
    }
    if (/\d/.test(char)) {
      const parsed = readNumberToken(input, index);
      tokens.push({ type: "number", value: parsed.value });
      index = parsed.nextIndex;
      continue;
    }
    const twoChar = input.slice(index, index + 2);
    if (
      twoChar === "&&" ||
      twoChar === "||" ||
      twoChar === "==" ||
      twoChar === "!=" ||
      twoChar === ">=" ||
      twoChar === "<="
    ) {
      tokens.push({ type: "operator", value: twoChar });
      index += 2;
      continue;
    }
    if (char === "!" || char === ">" || char === "<") {
      tokens.push({ type: "operator", value: char });
      index += 1;
      continue;
    }
    if (
      char === "." ||
      char === "(" ||
      char === ")" ||
      char === "," ||
      char === "[" ||
      char === "]" ||
      char === "*"
    ) {
      tokens.push({ type: "punctuation", value: char });
      index += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const parsed = readIdentifierToken(input, index);
      tokens.push({ type: "identifier", value: parsed.value });
      index = parsed.nextIndex;
      continue;
    }
    throw new Error(`Unsupported expression token near: ${input.slice(index)}`);
  }

  return tokens;
}

class Parser {
  private index = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly context: ExpressionContext,
  ) {}

  parse(): unknown {
    const value = this.parseOr();
    if (this.peek() !== undefined) {
      throw new Error("Unexpected trailing expression tokens");
    }
    return value;
  }

  private parseOr(): unknown {
    let left = this.parseAnd();
    while (this.matchOperator("||")) {
      const right = this.parseAnd();
      left = toBoolean(left) ? left : right;
    }
    return left;
  }

  private parseAnd(): unknown {
    let left = this.parseEquality();
    while (this.matchOperator("&&")) {
      const right = this.parseEquality();
      left = toBoolean(left) ? right : left;
    }
    return left;
  }

  private parseEquality(): unknown {
    let left = this.parseComparison();
    while (true) {
      if (this.matchOperator("==")) {
        left = valuesEqual(left, this.parseComparison());
        continue;
      }
      if (this.matchOperator("!=")) {
        left = !valuesEqual(left, this.parseComparison());
        continue;
      }
      return left;
    }
  }

  private parseComparison(): unknown {
    let left = this.parseUnary();
    while (true) {
      if (this.matchOperator(">")) {
        left = compareOrder(left, this.parseUnary(), ">");
        continue;
      }
      if (this.matchOperator(">=")) {
        left = compareOrder(left, this.parseUnary(), ">=");
        continue;
      }
      if (this.matchOperator("<")) {
        left = compareOrder(left, this.parseUnary(), "<");
        continue;
      }
      if (this.matchOperator("<=")) {
        left = compareOrder(left, this.parseUnary(), "<=");
        continue;
      }
      return left;
    }
  }

  private parseUnary(): unknown {
    if (this.matchOperator("!")) {
      return !toBoolean(this.parseUnary());
    }
    return this.parsePrimary();
  }

  private parsePrimary(): unknown {
    const token = this.consume();
    if (token === undefined) throw new Error("Unexpected end of expression");

    let value: unknown;
    if (token.type === "string" || token.type === "number") {
      value = token.value;
    } else if (token.type === "punctuation" && token.value === "(") {
      value = this.parseOr();
      this.expectPunctuation(")");
    } else if (token.type === "identifier") {
      if (token.value === "true") value = true;
      else if (token.value === "false") value = false;
      else if (token.value === "null") value = null;
      else if (this.matchPunctuation("("))
        value = this.callFunction(token.value, this.parseArguments());
      else value = resolvePath(this.context, [token.value]);
    } else {
      throw new Error("Expected expression value");
    }

    while (true) {
      if (this.matchPunctuation(".")) {
        value = resolveSegment(value, this.readDotSegment());
        continue;
      }
      if (this.matchPunctuation("[")) {
        value = resolveSegment(value, this.parseBracketSegment());
        this.expectPunctuation("]");
        continue;
      }
      return value;
    }
  }

  private readDotSegment(): PathSegment {
    if (this.matchPunctuation("*")) return "*";
    const segment = this.consume();
    if (segment?.type !== "identifier") throw new Error("Expected path segment after dot");
    return /^\d+$/u.test(segment.value) ? Number(segment.value) : segment.value;
  }

  private parseBracketSegment(): PathSegment {
    if (this.matchPunctuation("*")) return "*";
    const token = this.peek();
    if (token?.type === "string" || token?.type === "number") {
      this.consume();
      return token.value;
    }
    const value = this.parseOr();
    if (typeof value === "string" || typeof value === "number") return value;
    throw new Error("Bracket path segment must evaluate to string or number");
  }

  private parseArguments(): unknown[] {
    const args: unknown[] = [];
    if (this.matchPunctuation(")")) return args;
    while (true) {
      args.push(this.parseOr());
      if (this.matchPunctuation(")")) return args;
      this.expectPunctuation(",");
    }
  }

  private callFunction(name: string, args: unknown[]): unknown {
    if (name === "contains") {
      const [haystack, needle] = args;
      if (Array.isArray(haystack)) return haystack.some((entry) => valuesEqual(entry, needle));
      if (typeof haystack === "string" && typeof needle === "string") {
        return haystack.toLowerCase().includes(needle.toLowerCase());
      }
      return false;
    }
    if (name === "startsWith") return stringFunction(args, (left, right) => left.startsWith(right));
    if (name === "endsWith") return stringFunction(args, (left, right) => left.endsWith(right));
    if (name === "join") return joinFunction(args);
    if (name === "toJSON") return JSON.stringify(args[0], null, 2);
    if (name === "fromJSON") return fromJsonFunction(args[0]);
    if (name === "format") return formatFunction(args);
    if (name === "hashFiles") return hashFilesFunction(this.context, args);
    if (name === "success") return true;
    if (name === "failure") return false;
    if (name === "cancelled") return false;
    if (name === "always") return true;
    throw new Error(`Unsupported expression function: ${name}`);
  }

  private matchOperator(value: OperatorTokenValue): boolean {
    const token = this.peek();
    if (token?.type !== "operator" || token.value !== value) return false;
    this.index += 1;
    return true;
  }

  private matchPunctuation(value: PunctuationTokenValue): boolean {
    const token = this.peek();
    if (token?.type !== "punctuation" || token.value !== value) return false;
    this.index += 1;
    return true;
  }

  private expectPunctuation(value: PunctuationTokenValue): void {
    if (!this.matchPunctuation(value)) throw new Error(`Expected ${value}`);
  }

  private consume(): Token | undefined {
    const token = this.peek();
    if (token !== undefined) this.index += 1;
    return token;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }
}

function resolvePath(context: ExpressionContext, path: PathSegment[]): unknown {
  let current: unknown = context;
  for (const segment of path) {
    current = resolveSegment(current, segment);
  }
  return current;
}

function resolveSegment(current: unknown, segment: PathSegment): unknown {
  if (segment === "*") {
    if (Array.isArray(current)) return current;
    if (isRecord(current)) return Object.values(current);
    throw new Error("Missing expression value: *");
  }
  if (Array.isArray(current)) {
    if (typeof segment === "number") return readArrayIndex(current, segment);
    const numeric = /^\d+$/u.test(segment) ? Number(segment) : undefined;
    if (numeric !== undefined) return readArrayIndex(current, numeric);
    return current.flatMap((entry) => {
      const value = resolveSegment(entry, segment);
      return value === undefined ? [] : [value];
    });
  }
  if (!isRecord(current) || !(String(segment) in current)) return undefined;
  return current[String(segment)];
}

function readArrayIndex(values: unknown[], index: number): unknown {
  if (!(index in values)) return undefined;
  return values[index];
}

function readStringToken(
  input: string,
  startIndex: number,
  quote: string,
): { value: string; nextIndex: number } {
  let value = "";
  let index = startIndex + 1;
  while (index < input.length) {
    const char = input[index];
    if (quote === "'" && char === "'" && input[index + 1] === "'") {
      value += "'";
      index += 2;
      continue;
    }
    if (char === quote) return { value, nextIndex: index + 1 };
    if (char === "\\") {
      const nextChar = input[index + 1];
      if (nextChar === undefined) throw new Error("Unterminated string escape");
      value += nextChar;
      index += 2;
      continue;
    }
    value += char;
    index += 1;
  }
  throw new Error("Unterminated string literal");
}

function readNumberToken(input: string, startIndex: number): { value: number; nextIndex: number } {
  let index = startIndex;
  while (index < input.length && /[0-9.]/.test(input[index] ?? "")) index += 1;
  return { value: Number(input.slice(startIndex, index)), nextIndex: index };
}

function readIdentifierToken(
  input: string,
  startIndex: number,
): { value: string; nextIndex: number } {
  let index = startIndex;
  while (index < input.length && /[A-Za-z0-9_-]/.test(input[index] ?? "")) index += 1;
  return { value: input.slice(startIndex, index), nextIndex: index };
}

function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (typeof left === "string" && typeof right === "string") {
    return left.toLowerCase() === right.toLowerCase();
  }
  if (typeof left === typeof right) return left === right;
  const leftNumber = toGitHubNumber(left);
  const rightNumber = toGitHubNumber(right);
  return !Number.isNaN(leftNumber) && !Number.isNaN(rightNumber) && leftNumber === rightNumber;
}

function compareOrder(left: unknown, right: unknown, operator: ">" | ">=" | "<" | "<="): boolean {
  const leftValue = comparableValue(left);
  const rightValue = comparableValue(right);
  if (leftValue === undefined || rightValue === undefined) return false;
  if (operator === ">") return leftValue > rightValue;
  if (operator === ">=") return leftValue >= rightValue;
  if (operator === "<") return leftValue < rightValue;
  return leftValue <= rightValue;
}

function comparableValue(value: unknown): number | string | undefined {
  if (typeof value === "string") {
    const numeric = Number(value);
    return Number.isNaN(numeric) ? value.toLowerCase() : numeric;
  }
  const numeric = toGitHubNumber(value);
  return Number.isNaN(numeric) ? undefined : numeric;
}

function toGitHubNumber(value: unknown): number {
  if (value === null) return 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    if (value.trim().length === 0) return 0;
    return Number(value);
  }
  return Number.NaN;
}

function stringFunction(args: unknown[], fn: (left: string, right: string) => boolean): boolean {
  const [left, right] = args.map((arg) => valueToString(arg).toLowerCase());
  return left !== undefined && right !== undefined && fn(left, right);
}

function joinFunction(args: unknown[]): string {
  const [value, separator = ","] = args;
  if (Array.isArray(value))
    return value.map((entry) => valueToString(entry)).join(valueToString(separator));
  return valueToString(value);
}

function fromJsonFunction(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return JSON.parse(value) as unknown;
}

function formatFunction(args: unknown[]): string {
  const template = valueToString(args[0]);
  return args
    .slice(1)
    .reduce<string>(
      (current, value, index) => {
        return current.replaceAll(`{${index}}`, valueToString(value));
      },
      template.replaceAll("{{", "\u0000").replaceAll("}}", "\u0001"),
    )
    .replaceAll("\u0000", "{")
    .replaceAll("\u0001", "}");
}

function hashFilesFunction(context: ExpressionContext, args: unknown[]): string {
  const root = readString(context.__hashFilesRoot) ?? process.cwd();
  const files = resolveHashFiles(
    root,
    args.map((arg) => valueToString(arg)),
  );
  if (files.length === 0) return "";
  const combined = createHash("sha256");
  for (const file of files) {
    combined.update(createHash("sha256").update(readFileSync(file)).digest("hex"));
  }
  return combined.digest("hex");
}

function resolveHashFiles(root: string, patterns: string[]): string[] {
  const absoluteRoot = resolve(root);
  const allFiles = listFiles(absoluteRoot).toSorted();
  const included = new Set<string>();
  for (const pattern of patterns) {
    const isExclude = pattern.startsWith("!");
    const matcher = globMatcher(isExclude ? pattern.slice(1) : pattern);
    for (const file of allFiles) {
      const relativePath = relative(absoluteRoot, file).split(sep).join("/");
      if (!matcher(relativePath)) continue;
      if (isExclude) included.delete(file);
      else included.add(file);
    }
  }
  return [...included].toSorted();
}

function listFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const stat = statSync(root);
  if (stat.isFile()) return [root];
  if (!stat.isDirectory()) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === ".git" || entry.name === "node_modules") return [];
    const entryPath = resolve(root, entry.name);
    if (entry.isDirectory()) return listFiles(entryPath);
    return entry.isFile() ? [entryPath] : [];
  });
}

function globMatcher(pattern: string): (value: string) => boolean {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\//u, "");
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === undefined) break;
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegex(char);
  }
  return (value) => new RegExp(`^${source}$`, "u").test(value);
}

function escapeRegex(value: string): string {
  return value.replaceAll(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function valueToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  if (value === undefined) return "";
  return JSON.stringify(value) ?? "";
}
