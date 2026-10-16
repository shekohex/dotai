/**
 * Markdown as simple blocks React Native can draw: headings, paragraphs, list items, quotes,
 * tables, rules, and code. Adapted from the write-up parser of the Progress plugin by
 * Steve Castaneda (MIT); inline marks are kept as styled spans instead of being dropped.
 */

export interface Span {
  text: string;
  code?: boolean;
  bold?: boolean;
  italic?: boolean;
  link?: string;
}

export type Block =
  | { kind: "heading"; level: number; spans: Span[] }
  | { kind: "paragraph"; spans: Span[] }
  | { kind: "quote"; spans: Span[] }
  /** `marker` is "•" for bullets, "1." and so on for numbered items, "☐"/"☑" for tasks. */
  | { kind: "item"; marker: string; depth: number; spans: Span[] }
  | { kind: "table"; rows: Span[][][] }
  | { kind: "rule" }
  | { kind: "code"; text: string };

const INLINE =
  /(`[^`]+`)|(\*\*|__)(.+?)\2|(?<=^|[\s(])([*_])(?![*_\s])(.*?\S)\4(?=[\s).,;:!?]|$)|!?\[([^\]]*)\]\(([^)\s]*)[^)]*\)/;

export function spans(text: string): Span[] {
  const result: Span[] = [];
  let rest = text;
  while (rest) {
    const match = INLINE.exec(rest);
    if (!match) {
      result.push({ text: rest });
      break;
    }
    const before = rest.slice(0, match.index);
    if (before) result.push({ text: before });
    if (match[1]) result.push({ text: match[1].slice(1, -1), code: true });
    else if (match[2]) result.push({ text: match[3] ?? "", bold: true });
    else if (match[4]) result.push({ text: match[5] ?? "", italic: true });
    else result.push({ text: match[6] ?? "", link: match[7] ?? "" });
    rest = rest.slice(match.index + match[0].length);
  }
  return result.filter((span) => span.text);
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

export function parseMarkdown(markdown: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let quote: string[] = [];
  let table: string[][] | null = null;
  let fence: string[] | null = null;
  const flush = () => {
    if (paragraph.length)
      blocks.push({ kind: "paragraph", spans: spans(paragraph.join(" ")) });
    if (quote.length)
      blocks.push({ kind: "quote", spans: spans(quote.join(" ")) });
    if (table)
      blocks.push({
        kind: "table",
        rows: table.map((row) => row.map((cell) => spans(cell))),
      });
    paragraph = [];
    quote = [];
    table = null;
  };
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (fence) {
      if (/^\s*(```|~~~)/.test(raw)) {
        blocks.push({ kind: "code", text: fence.join("\n") });
        fence = null;
      } else fence.push(raw);
      continue;
    }
    if (/^\s*(```|~~~)/.test(raw)) {
      flush();
      fence = [];
      continue;
    }
    const line = raw.trimEnd();
    const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line);
    const item = /^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line);
    if (!line.trim()) flush();
    else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
    } else if (/^\s*\|.*\|\s*$/.test(line)) {
      if (!table) {
        flush();
        table = [];
      }
      // The |---|---| line only separates the header.
      if (!/^\s*\|[\s:|-]+\|\s*$/.test(line)) table.push(tableCells(line));
    } else if (heading?.[1]) {
      flush();
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        spans: spans(heading[2] ?? ""),
      });
    } else if (item) {
      flush();
      const marker =
        item[3] !== undefined
          ? item[3] === " "
            ? "☐"
            : "☑"
          : /\d/.test(item[2] ?? "")
            ? (item[2] ?? "").replace(")", ".")
            : "•";
      blocks.push({
        kind: "item",
        marker,
        depth: Math.floor((item[1] ?? "").replace(/\t/g, "  ").length / 2),
        spans: spans(item[4] ?? ""),
      });
    } else if (/^\s*>/.test(line)) {
      if (paragraph.length || table) flush();
      quote.push(line.replace(/^\s*>\s?/, ""));
    } else if (
      /^\s{2,}\S/.test(line) &&
      blocks.at(-1)?.kind === "item" &&
      !paragraph.length
    ) {
      // A wrapped list item continues on an indented line.
      const last = blocks.at(-1) as Extract<Block, { kind: "item" }>;
      last.spans = [...last.spans, ...spans(` ${line.trim()}`)];
    } else {
      if (quote.length || table) flush();
      paragraph.push(line.trim());
    }
  }
  flush();
  if (fence) blocks.push({ kind: "code", text: fence.join("\n") });
  return blocks;
}

export function isMarkdown(target: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(target);
}
