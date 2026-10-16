export type FenceSegment =
  | { kind: "text"; text: string }
  | { kind: "ui"; ui: string; title?: string; complete: boolean };

const OPEN = /^[ \t]*```openui(?:[ \t]+(.*?))?[ \t]*$/;
const CLOSE = /^[ \t]*```[ \t]*$/;

export function hasFence(text: string): boolean {
  return text.split("\n").some((line) => OPEN.test(line));
}

/** Splits an assistant message into prose and ```openui blocks. A block still streaming is `complete: false`. */
export function splitFences(text: string): FenceSegment[] {
  const segments: FenceSegment[] = [];
  let prose: string[] = [];
  let block: { lines: string[]; title?: string } | null = null;
  const flushProse = () => {
    const joined = prose.join("\n").trim();
    if (joined) segments.push({ kind: "text", text: joined });
    prose = [];
  };
  for (const line of text.split("\n")) {
    if (block) {
      if (CLOSE.test(line)) {
        segments.push({ kind: "ui", ui: block.lines.join("\n"), ...(block.title ? { title: block.title } : {}), complete: true });
        block = null;
      } else {
        block.lines.push(line);
      }
      continue;
    }
    const open = OPEN.exec(line);
    if (open) {
      flushProse();
      block = { lines: [], ...(open[1] ? { title: open[1] } : {}) };
    } else {
      prose.push(line);
    }
  }
  if (block) {
    segments.push({ kind: "ui", ui: block.lines.join("\n"), ...(block.title ? { title: block.title } : {}), complete: false });
  } else {
    flushProse();
  }
  return segments;
}
