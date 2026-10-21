const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

export interface LimitedPatch {
  patch: string;
  truncated: boolean;
}

/**
 * Cuts a one-file patch after `maxLines` body lines and rewrites the last hunk header so the
 * counts still match. Pierre renders every line it is given, so huge patches need a bound.
 */
export function limitPatch(patch: string, maxLines: number): LimitedPatch {
  const lines = patch.split("\n");
  if (lines.length <= maxLines) return { patch, truncated: false };
  const kept = lines.slice(0, maxLines);
  let hunkStart = -1;
  for (let index = kept.length - 1; index >= 0; index--) {
    if (kept[index]?.startsWith("@@ ")) {
      hunkStart = index;
      break;
    }
  }
  if (hunkStart < 0) return { patch: kept.join("\n"), truncated: true };
  const match = HUNK_HEADER.exec(kept[hunkStart] ?? "");
  if (!match) return { patch: kept.join("\n"), truncated: true };
  let oldCount = 0;
  let newCount = 0;
  for (const line of kept.slice(hunkStart + 1)) {
    const marker = line[0];
    if (marker === "+") newCount++;
    else if (marker === "-") oldCount++;
    else if (marker === " ") {
      oldCount++;
      newCount++;
    }
  }
  kept[hunkStart] = `@@ -${match[1]},${oldCount} +${match[2]},${newCount} @@${match[3]}`;
  return { patch: kept.join("\n"), truncated: true };
}
