import { isRecord } from "../utils/unknown-data.js";

type Token =
  | { type: "identifier"; value: string }
  | { type: "string"; value: string }
  | { type: "number"; value: number }
  | { type: "operator"; value: "&&" | "||" | "==" | "!=" | "!" }
  | { type: "punctuation"; value: "." | "(" | ")" | "," };

type ExpressionContext = Record<string, unknown>;
type OperatorTokenValue = Extract<Token, { type: "operator" }>["value"];
type PunctuationTokenValue = Extract<Token, { type: "punctuation" }>["value"];

export function evaluateWrappedExpression(expression: string, context: ExpressionContext): unknown {
  const inner = unwrapExpression(expression);
  return new Parser(tokenize(inner), context).parse();
}

export function evaluateCondition(
  expression: string | undefined,
  context: ExpressionContext,
): boolean {
  if (expression === undefined || expression.trim().length === 0) return true;
  return toBoolean(evaluateWrappedExpression(expression, context));
}

export function renderTemplate(template: string, context: ExpressionContext): string {
  return template.replaceAll(/\$\{\{([\s\S]*?)\}\}/g, (_match, expression: string) => {
    const value = new Parser(tokenize(expression.trim()), context).parse();
    if (value === undefined) {
      throw new Error(`Expression produced missing value: \${{ ${expression.trim()} }}`);
    }
    return valueToString(value);
  });
}

function unwrapExpression(expression: string): string {
  const trimmed = expression.trim();
  if (!trimmed.startsWith("${{") || !trimmed.endsWith("}}")) {
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
    if (twoChar === "&&" || twoChar === "||" || twoChar === "==" || twoChar === "!=") {
      tokens.push({ type: "operator", value: twoChar });
      index += 2;
      continue;
    }
    if (char === "!") {
      tokens.push({ type: "operator", value: "!" });
      index += 1;
      continue;
    }
    if (char === "." || char === "(" || char === ")" || char === ",") {
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
      left = toBoolean(left) || toBoolean(right);
    }
    return left;
  }

  private parseAnd(): unknown {
    let left = this.parseEquality();
    while (this.matchOperator("&&")) {
      const right = this.parseEquality();
      left = toBoolean(left) && toBoolean(right);
    }
    return left;
  }

  private parseEquality(): unknown {
    let left = this.parseUnary();
    while (true) {
      if (this.matchOperator("==")) {
        left = compareValues(left, this.parseUnary());
        continue;
      }
      if (this.matchOperator("!=")) {
        left = !compareValues(left, this.parseUnary());
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

    if (token.type === "string" || token.type === "number") return token.value;
    if (token.type === "punctuation" && token.value === "(") {
      const value = this.parseOr();
      this.expectPunctuation(")");
      return value;
    }
    if (token.type !== "identifier") {
      throw new Error("Expected expression value");
    }

    if (token.value === "true") return true;
    if (token.value === "false") return false;
    if (token.value === "null") return null;

    if (this.matchPunctuation("(")) {
      return this.callFunction(token.value, this.parseArguments());
    }

    const path = [token.value];
    while (this.matchPunctuation(".")) {
      const segment = this.consume();
      if (segment?.type !== "identifier") throw new Error("Expected path segment after dot");
      path.push(segment.value);
    }
    return resolvePath(this.context, path);
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
      if (Array.isArray(haystack)) return haystack.some((entry) => compareValues(entry, needle));
      if (typeof haystack === "string" && typeof needle === "string")
        return haystack.includes(needle);
      return false;
    }
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

function resolvePath(context: ExpressionContext, path: string[]): unknown {
  let current: unknown = context;
  for (const segment of path) {
    if (!isRecord(current) || !(segment in current)) {
      throw new Error(`Missing expression value: ${path.join(".")}`);
    }
    current = current[segment];
  }
  return current;
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

function compareValues(left: unknown, right: unknown): boolean {
  return left === right;
}

function valueToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return JSON.stringify(value);
}
