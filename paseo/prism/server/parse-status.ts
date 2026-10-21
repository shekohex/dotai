import type { ChangedFile } from "../shared/contracts.js";

export interface ParsedStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: ChangedFile[];
}

type FileStatus = ChangedFile["status"];

function deriveStatus(index: string, worktree: string): FileStatus {
  if (index === "R" || worktree === "R" || index === "C" || worktree === "C") return "renamed";
  if (index === "A") return "added";
  if (index === "D" || worktree === "D") return "deleted";
  return "modified";
}

function nthSpaceIndex(text: string, count: number): number {
  let index = -1;
  for (let seen = 0; seen < count; seen += 1) {
    index = text.indexOf(" ", index + 1);
    if (index === -1) return -1;
  }
  return index;
}

/** Parses `git status --porcelain=v2 --branch -z`. Counts are filled in by the caller. */
export function parseStatus(output: string): ParsedStatus {
  const result: ParsedStatus = { branch: null, upstream: null, ahead: 0, behind: 0, files: [] };
  const tokens = output.split("\0");
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? "";
    if (token.startsWith("# branch.head ")) {
      const head = token.slice("# branch.head ".length);
      result.branch = head === "(detached)" ? null : head;
    } else if (token.startsWith("# branch.upstream ")) {
      result.upstream = token.slice("# branch.upstream ".length);
    } else if (token.startsWith("# branch.ab ")) {
      const match = /\+(\d+) -(\d+)/.exec(token);
      result.ahead = Number(match?.[1] ?? 0);
      result.behind = Number(match?.[2] ?? 0);
    } else if (token.startsWith("1 ") || token.startsWith("2 ")) {
      const isRename = token.startsWith("2 ");
      const xy = token.slice(2, 4);
      const path = token.slice(nthSpaceIndex(token, isRename ? 9 : 8) + 1);
      const oldPath = isRename ? (tokens[(i += 1)] ?? null) : null;
      const index = xy[0] ?? ".";
      const worktree = xy[1] ?? ".";
      result.files.push({
        path,
        oldPath,
        status: deriveStatus(index, worktree),
        staged: index !== ".",
        unstaged: worktree !== ".",
        additions: 0,
        deletions: 0,
        binary: false,
        rev: "",
      });
    } else if (token.startsWith("u ")) {
      result.files.push({
        path: token.slice(nthSpaceIndex(token, 10) + 1),
        oldPath: null,
        status: "conflicted",
        staged: false,
        unstaged: true,
        additions: 0,
        deletions: 0,
        binary: false,
        rev: "",
      });
    } else if (token.startsWith("? ")) {
      result.files.push({
        path: token.slice(2),
        oldPath: null,
        status: "untracked",
        staged: false,
        unstaged: true,
        additions: 0,
        deletions: 0,
        binary: false,
        rev: "",
      });
    }
  }
  return result;
}

export interface NumstatEntry {
  additions: number;
  deletions: number;
  binary: boolean;
}

/** Parses `git diff --numstat -z`, keyed by the new path. */
export function parseNumstat(output: string): Map<string, NumstatEntry> {
  const entries = new Map<string, NumstatEntry>();
  const tokens = output.split("\0");
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? "";
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(token);
    if (!match) continue;
    const binary = match[1] === "-";
    let path = match[3] ?? "";
    if (path === "") {
      i += 1; // rename: old path, then new path
      path = tokens[(i += 1)] ?? "";
    }
    entries.set(path, {
      additions: binary ? 0 : Number(match[1]),
      deletions: binary ? 0 : Number(match[2]),
      binary,
    });
  }
  return entries;
}

export interface NameStatusEntry {
  path: string;
  oldPath: string | null;
  status: "modified" | "added" | "deleted" | "renamed";
}

/** Parses `git diff --name-status -z -M`. */
export function parseNameStatus(output: string): NameStatusEntry[] {
  const entries: NameStatusEntry[] = [];
  const tokens = output.split("\0");
  for (let i = 0; i < tokens.length; i += 1) {
    const code = tokens[i] ?? "";
    if (code === "") continue;
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      const oldPath = tokens[(i += 1)] ?? "";
      const path = tokens[(i += 1)] ?? "";
      entries.push({ path, oldPath, status: "renamed" });
    } else {
      const path = tokens[(i += 1)] ?? "";
      entries.push({
        path,
        oldPath: null,
        status: letter === "A" ? "added" : letter === "D" ? "deleted" : "modified",
      });
    }
  }
  return entries;
}
