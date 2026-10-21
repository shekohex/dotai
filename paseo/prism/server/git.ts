import { execFile } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { parsePatchRows } from "../shared/diff-parse.js";
import type { ChangedFile, Compare } from "../shared/contracts.js";
import { languageForPath, tokenizeLines, type LineTokens } from "./highlight.js";
import {
  parseNameStatus,
  parseNumstat,
  parseStatus,
  type ParsedStatus,
} from "./parse-status.js";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const GIT_TIMEOUT_MS = 30_000;
const DIFF_MAX_BYTES = 2 * 1024 * 1024;
const LIST_MAX_BYTES = 64 * 1024 * 1024;
const UNTRACKED_COUNT_LIMIT = 200;
const UNTRACKED_COUNT_MAX_BYTES = 512 * 1024;
const HIGHLIGHT_MAX_BYTES = 300 * 1024;
const FILE_LIST_LIMIT = 100_000;
const IGNORED_LIST_LIMIT = 30_000;
const WALK_SKIPPED = new Set([".git", "node_modules"]);
const FALLBACK_BASES = ["main", "master", "develop"];

interface GitResult {
  stdout: string;
  code: number;
  overflow: boolean;
}

/** Runs git without taking optional locks, so it never blocks Paseo's own git work. */
function runGit(
  cwd: string,
  args: readonly string[],
  maxBuffer = LIST_MAX_BYTES,
): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["--no-pager", ...args],
      {
        cwd,
        maxBuffer,
        timeout: GIT_TIMEOUT_MS,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
      },
      (error, stdout) => {
        const failure = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
        const overflow = failure?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        const code = failure ? (typeof failure.code === "number" ? failure.code : 128) : 0;
        resolve({ stdout: String(stdout ?? ""), code, overflow });
      },
    );
  });
}

async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return result.code === 0 && result.stdout.trim() === "true";
}

async function revParse(cwd: string, rev: string): Promise<string | null> {
  const result = await runGit(cwd, ["rev-parse", "--verify", "--quiet", rev]);
  return result.code === 0 ? result.stdout.trim() : null;
}

async function defaultBaseBranch(cwd: string): Promise<string | null> {
  const remoteHead = await runGit(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead.code === 0 && remoteHead.stdout.trim() !== "") return remoteHead.stdout.trim();
  for (const name of FALLBACK_BASES) {
    if (await revParse(cwd, `refs/heads/${name}`)) return name;
  }
  return null;
}

/** How a comparison maps onto git: what the old side is, where the new side lives, which args diff them. */
interface ComparePlan {
  applied: Compare;
  oldRev: string;
  newSide: "worktree" | "head";
  diffArgs: string[];
  includeUntracked: boolean;
  defaultBase: string | null;
}

async function planCompare(cwd: string, compare: Compare): Promise<ComparePlan> {
  const defaultBase = await defaultBaseBranch(cwd);
  const head = (await revParse(cwd, "HEAD")) !== null;
  const uncommitted = (): ComparePlan => {
    const oldRev = head ? "HEAD" : EMPTY_TREE;
    return {
      applied: { mode: "uncommitted", baseRef: compare.baseRef },
      oldRev,
      newSide: "worktree",
      diffArgs: [oldRev],
      includeUntracked: true,
      defaultBase,
    };
  };
  if (compare.mode === "uncommitted" || !head) return uncommitted();
  const baseRef = compare.baseRef ?? defaultBase;
  const mergeBase = baseRef ? await runGit(cwd, ["merge-base", baseRef, "HEAD"]) : null;
  const base = mergeBase && mergeBase.code === 0 ? mergeBase.stdout.trim() : null;
  if (!base) return uncommitted();
  const applied = { mode: compare.mode, baseRef } satisfies Compare;
  return compare.mode === "committed"
    ? { applied, oldRev: base, newSide: "head", diffArgs: [base, "HEAD"], includeUntracked: false, defaultBase }
    : { applied, oldRev: base, newSide: "worktree", diffArgs: [base], includeUntracked: true, defaultBase };
}

async function countLines(path: string): Promise<number | null> {
  try {
    const buffer = await readFile(path);
    if (buffer.length > UNTRACKED_COUNT_MAX_BYTES || buffer.includes(0)) return null;
    let lines = 0;
    for (const byte of buffer) if (byte === 10) lines += 1;
    return buffer.length > 0 && buffer[buffer.length - 1] !== 10 ? lines + 1 : lines;
  } catch {
    return null;
  }
}

async function worktreeRev(cwd: string, path: string): Promise<string> {
  try {
    const stats = await lstat(join(cwd, path));
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return "gone";
  }
}

function blankFile(partial: Pick<ChangedFile, "path" | "oldPath" | "status">): ChangedFile {
  return {
    ...partial,
    staged: false,
    unstaged: true,
    additions: 0,
    deletions: 0,
    binary: false,
    rev: "",
  };
}

async function collectFiles(cwd: string, plan: ComparePlan, porcelain: ParsedStatus): Promise<ChangedFile[]> {
  let files: ChangedFile[];
  if (plan.applied.mode === "uncommitted") {
    files = porcelain.files;
  } else {
    const nameStatus = parseNameStatus(
      (await runGit(cwd, ["diff", "--no-ext-diff", ...plan.diffArgs, "--name-status", "-z", "-M"])).stdout,
    );
    files = nameStatus.map((entry) => blankFile(entry));
    if (plan.includeUntracked) {
      const known = new Set(files.map((file) => file.path));
      for (const file of porcelain.files) if (file.status === "untracked" && !known.has(file.path)) files.push(file);
    }
  }
  const numstat = parseNumstat((await runGit(cwd, ["diff", "--no-ext-diff", ...plan.diffArgs, "--numstat", "-z"])).stdout);
  const head = plan.newSide === "head" ? ((await revParse(cwd, "HEAD")) ?? "") : "";
  let untrackedCounted = 0;
  for (const file of files) {
    const counts = numstat.get(file.path);
    if (counts) {
      file.additions = counts.additions;
      file.deletions = counts.deletions;
      file.binary = counts.binary;
    } else if (file.status === "untracked" && untrackedCounted < UNTRACKED_COUNT_LIMIT) {
      untrackedCounted += 1;
      file.additions = (await countLines(join(cwd, file.path))) ?? 0;
    }
  }
  await Promise.all(
    files.map(async (file) => {
      file.rev = plan.newSide === "head" ? head : await worktreeRev(cwd, file.path);
    }),
  );
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export interface RepoStatus {
  isGit: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: ChangedFile[];
  defaultBase: string | null;
  applied: Compare;
}

export async function readStatus(cwd: string, compare: Compare): Promise<RepoStatus> {
  if (!(await isGitRepo(cwd))) {
    return {
      isGit: false,
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      files: [],
      defaultBase: null,
      applied: { mode: "uncommitted", baseRef: null },
    };
  }
  const [porcelain, plan] = await Promise.all([
    runGit(cwd, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]),
    planCompare(cwd, compare),
  ]);
  const parsed = parseStatus(porcelain.stdout);
  const files = await collectFiles(cwd, plan, parsed);
  return {
    isGit: true,
    branch: parsed.branch,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    files,
    defaultBase: plan.defaultBase,
    applied: plan.applied,
  };
}

export async function listBranches(cwd: string): Promise<{
  current: string | null;
  defaultBase: string | null;
  branches: string[];
}> {
  if (!(await isGitRepo(cwd))) return { current: null, defaultBase: null, branches: [] };
  const [refs, current, defaultBase] = await Promise.all([
    runGit(cwd, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)", "refs/heads", "refs/remotes"]),
    runGit(cwd, ["branch", "--show-current"]),
    defaultBaseBranch(cwd),
  ]);
  const branches = refs.stdout
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name !== "" && !name.endsWith("/HEAD"))
    .map((name) => name.replace(/^refs\/(heads|remotes)\//, ""));
  return { current: current.stdout.trim() || null, defaultBase, branches };
}

export interface FileDiffResult {
  patch: string;
  binary: boolean;
  tooLarge: boolean;
  tokens: LineTokens[] | null;
}

async function readText(path: string): Promise<string | null> {
  try {
    const buffer = await readFile(path);
    return buffer.length > HIGHLIGHT_MAX_BYTES || buffer.includes(0) ? null : buffer.toString("utf8");
  } catch {
    return null;
  }
}

async function readBlob(cwd: string, rev: string, path: string): Promise<string | null> {
  const result = await runGit(cwd, ["show", `${rev}:${path}`], HIGHLIGHT_MAX_BYTES);
  return result.code === 0 && !result.overflow && !result.stdout.includes("\0") ? result.stdout : null;
}

/** Highlights whole files so multi-line constructs tokenize correctly, then picks the patch's lines. */
async function highlightPatch(input: {
  cwd: string;
  plan: ComparePlan;
  path: string;
  oldPath: string | null;
  patch: string;
  syntax: string;
}): Promise<LineTokens[] | null> {
  const { cwd, plan, path, oldPath, patch, syntax } = input;
  const language = languageForPath(path);
  if (!language) return null;
  const rows = parsePatchRows(patch);
  const needsNew = rows.some((row) => row.type === "line" && row.line.newNo !== null);
  const needsOld = rows.some((row) => row.type === "line" && row.line.kind === "del");
  const [newText, oldText] = await Promise.all([
    needsNew
      ? plan.newSide === "worktree"
        ? readText(join(cwd, path))
        : readBlob(cwd, "HEAD", path)
      : null,
    needsOld ? readBlob(cwd, plan.oldRev, oldPath ?? path) : null,
  ]);
  const newLines = newText === null ? null : await tokenizeLines(newText, language, syntax);
  const oldLines = oldText === null ? null : await tokenizeLines(oldText, language, syntax);
  if (!newLines && !oldLines) return null;
  const tokens: LineTokens[] = [];
  for (const row of rows) {
    if (row.type !== "line") continue;
    const { line } = row;
    const source = line.kind === "del" ? oldLines?.[(line.oldNo ?? 1) - 1] : newLines?.[(line.newNo ?? 1) - 1];
    tokens.push(source ?? []);
  }
  return tokens;
}

export async function readFileDiff(input: {
  cwd: string;
  path: string;
  oldPath: string | null;
  compare: Compare;
  ignoreWhitespace: boolean;
  syntax: string;
}): Promise<FileDiffResult> {
  const { cwd, path, oldPath, ignoreWhitespace, syntax } = input;
  const plan = await planCompare(cwd, input.compare);
  const flags = ["--no-color", "--no-ext-diff", ...(ignoreWhitespace ? ["-w"] : [])];
  const tracked = await runGit(
    cwd,
    ["diff", ...plan.diffArgs, ...flags, "--", ...(oldPath ? [oldPath, path] : [path])],
    DIFF_MAX_BYTES,
  );
  let result = tracked;
  if (!tracked.overflow && tracked.stdout === "" && plan.includeUntracked) {
    const known = await runGit(cwd, ["ls-files", "--error-unmatch", "--", path]);
    if (known.code !== 0) {
      // Untracked: git exits 1 when the files differ, which is the expected case here.
      result = await runGit(cwd, ["diff", "--no-index", ...flags, "--", "/dev/null", path], DIFF_MAX_BYTES);
    }
  }
  if (result.overflow) return { patch: "", binary: false, tooLarge: true, tokens: null };
  const binary = /^Binary files .* differ$/m.test(result.stdout);
  if (binary) return { patch: "", binary, tooLarge: false, tokens: null };
  const tokens = await highlightPatch({ cwd, plan, path, oldPath, patch: result.stdout, syntax });
  return { patch: result.stdout, binary, tooLarge: false, tokens };
}

async function walkDirectory(root: string, relative: string, out: string[], limit = FILE_LIST_LIMIT): Promise<void> {
  if (out.length >= limit) return;
  const entries = await readdir(join(root, relative), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (WALK_SKIPPED.has(entry.name)) continue;
    const next = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) await walkDirectory(root, next, out, limit);
    else out.push(next);
  }
}

export interface FileList {
  paths: string[];
  ignored: string[];
  truncated: boolean;
}

export async function listFiles(cwd: string, includeIgnored: boolean): Promise<FileList> {
  if (!(await isGitRepo(cwd))) {
    const paths: string[] = [];
    await walkDirectory(cwd, "", paths);
    return { paths, ignored: [], truncated: paths.length >= FILE_LIST_LIMIT };
  }
  const listed = await runGit(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  const paths = [...new Set(listed.stdout.split("\0").filter((path) => path !== ""))];
  let ignored: string[] = [];
  if (includeIgnored) {
    // `--directory` lists an ignored folder once instead of walking node_modules and friends.
    const extra = await runGit(cwd, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]);
    const roots = extra.stdout.split("\0").filter((path) => path !== "");
    ignored = [...roots];
    // Open each ignored folder (build output, caches) so its files can be browsed; node_modules and
    // .git stay listed as closed folders.
    const contents: string[] = [];
    for (const root of roots) {
      if (!root.endsWith("/")) continue;
      if (WALK_SKIPPED.has(root.slice(0, -1).split("/").pop() ?? "")) continue;
      await walkDirectory(cwd, root.slice(0, -1), contents, IGNORED_LIST_LIMIT);
    }
    ignored.push(...contents);
    paths.push(...ignored);
  }
  const truncated = paths.length > FILE_LIST_LIMIT;
  return { paths: truncated ? paths.slice(0, FILE_LIST_LIMIT) : paths, ignored, truncated };
}
