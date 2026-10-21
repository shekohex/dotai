export type DiffLineKind = "context" | "add" | "del" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export type DiffRow =
  | { key: string; type: "hunk"; header: string }
  | { key: string; type: "line"; line: DiffLine };

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

/** Flattens a single-file unified patch into list rows. File headers before the first hunk are dropped. */
export function parsePatchRows(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      oldNo = Number(header[1]);
      newNo = Number(header[2]);
      inHunk = true;
      rows.push({ key: `h${rows.length}`, type: "hunk", header: raw });
      continue;
    }
    if (!inHunk) continue;
    const marker = raw[0];
    const text = raw.slice(1);
    let line: DiffLine;
    if (marker === "+") line = { kind: "add", oldNo: null, newNo: newNo++, text };
    else if (marker === "-") line = { kind: "del", oldNo: oldNo++, newNo: null, text };
    else if (marker === "\\") line = { kind: "meta", oldNo: null, newNo: null, text: raw };
    else if (marker === " ") line = { kind: "context", oldNo: oldNo++, newNo: newNo++, text };
    else continue; // trailing empty string after the final newline
    rows.push({ key: `l${rows.length}`, type: "line", line });
  }
  return rows;
}
