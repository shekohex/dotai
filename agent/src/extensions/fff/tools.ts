import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GrepCursor, GrepMode } from "@ff-labs/fff-node";
import { Type } from "typebox";
import { DEFAULT_FIND_LIMIT, DEFAULT_GREP_LIMIT, TOOL_NAMES } from "./constants.js";
import { formatFindOutput, formatGrepOutput } from "./format.js";
import { nowMs, renderSearchCall, renderSearchResult } from "./render.js";
import type { FffToolRuntime } from "./types.js";
import { buildQuery } from "./query.js";

// ---------------------------------------------------------------------------
// Cursor store — simple bounded Map for pagination cursors
// ---------------------------------------------------------------------------

const cursorCache = new Map<string, GrepCursor>();
let cursorCounter = 0;

function storeCursor(cursor: GrepCursor): string {
  const id = `fff_c${++cursorCounter}`;
  cursorCache.set(id, cursor);
  if (cursorCache.size > 200) {
    const first = cursorCache.keys().next().value;
    if (first !== undefined) cursorCache.delete(first);
  }
  return id;
}

function getCursor(id: string): GrepCursor | undefined {
  return cursorCache.get(id);
}

// Find pagination uses a page-index cursor: native `fileSearch` takes
// pageIndex/pageSize, so the cursor is just the next page index paired with
// the query+limit that produced it. Stored tokens are opaque IDs to the agent.
interface FindCursor {
  query: string;
  pattern: string;
  pageSize: number;
  nextPageIndex: number;
}

const findCursorCache = new Map<string, FindCursor>();
let findCursorCounter = 0;

function storeFindCursor(cursor: FindCursor): string {
  const id = `${++findCursorCounter}`;
  findCursorCache.set(id, cursor);
  if (findCursorCache.size > 200) {
    const first = findCursorCache.keys().next().value;
    if (first !== undefined) findCursorCache.delete(first);
  }
  return id;
}

function getFindCursor(id: string): FindCursor | undefined {
  return findCursorCache.get(id);
}

function buildToolQuery(input: {
  tool: "grep" | "find";
  path: string | undefined;
  pattern: string;
  exclude: string | string[] | undefined;
  cwd: string;
}): string {
  try {
    return buildQuery(input.path, input.pattern, input.exclude, input.cwd);
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes("relative to the workspace")) {
      const fallbackTool = input.tool === "grep" ? "rg" : "fd";
      throw new Error(
        `Path is outside workspace: ${input.path}. FFF only searches indexed workspace files. Use bash with \`${fallbackTool}\` for paths outside repo.`,
        { cause: error },
      );
    }

    throw error;
  }
}

// --- grep tool ---

const grepSchema = Type.Object({
  pattern: Type.String({
    description: "Search pattern (literal text or regex)",
  }),
  path: Type.Optional(
    Type.String({
      description:
        "Repo-relative path constraint. Directory prefix (src/ or src/foo/), bare filename with extension (main.rs), or glob (*.ts, src/**/*.cc, {src,lib}/**). Applied to the full repo-relative path.",
    }),
  ),
  exclude: Type.Optional(
    Type.Union([Type.String(), Type.Array(Type.String())], {
      description:
        "Exclude paths (comma/space-separated or array). Same syntax as path: directory prefix ('test/'), filename with extension ('config.json'), or glob ('*.min.js', '**/*.{rs,go}'). A leading '!' is optional and ignored — both 'test/' and '!test/' work. Example: 'test/,*.min.js,!vendor/'.",
    }),
  ),
  caseSensitive: Type.Optional(
    Type.Boolean({
      description:
        "Force case-sensitive matching. Default uses smart-case (case-insensitive when pattern is all lowercase).",
    }),
  ),
  context: Type.Optional(Type.Number({ description: "Context lines before+after each match" })),
  limit: Type.Optional(
    Type.Number({
      description: `Max matches (default ${DEFAULT_GREP_LIMIT})`,
    }),
  ),
  cursor: Type.Optional(Type.String({ description: "Pagination cursor from previous result" })),
});

// --- find tool ---

const findSchema = Type.Object({
  pattern: Type.String({
    description:
      "Fuzzy filename search and glob search. Frecency-ranked, git-aware. Multi-word = narrower (AND) not bound to order, use for multi word related concept search. Prefer this over ls/find/bash as the first exploration step whenever the user names a concept, feature, or symbol — it surfaces the relevant files in one call. Only use ls/read on a directory when you specifically need the alphabetical layout of an unknown repo, or when a concept search returned nothing.",
  }),
  path: Type.Optional(
    Type.String({
      description:
        "Repo-relative path constraint. Directory prefix (src/ or src/foo/), bare filename with extension (main.rs), or glob (*.ts, src/**/*.cc, {src,lib}/**). Applied to the full repo-relative path.",
    }),
  ),
  exclude: Type.Optional(
    Type.Union([Type.String(), Type.Array(Type.String())], {
      description:
        "Exclude paths (comma/space-separated or array). Same syntax as path: directory prefix ('test/'), filename with extension ('config.json'), or glob ('*.min.js', '**/*.{rs,go}'). A leading '!' is optional and ignored — both 'test/' and '!test/' work. Example: 'test/,*.min.js,!vendor/'.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: `Max results per page (default ${DEFAULT_FIND_LIMIT})`,
    }),
  ),
  cursor: Type.Optional(Type.String({ description: "Pagination cursor from previous result" })),
});

function registerGrepTool(pi: ExtensionAPI, runtime: FffToolRuntime): void {
  pi.registerTool({
    name: TOOL_NAMES.grep,
    label: TOOL_NAMES.grep,
    renderShell: "self",
    description: `Grep file contents. Smart-case, auto-detects regex vs literal, git-aware. Results are ranked by frecency (most-accessed files first); matches within a file stay in source order. Default limit ${DEFAULT_GREP_LIMIT}.`,
    promptSnippet: "Grep contents",
    promptGuidelines: [
      "Prefer bare identifiers as patterns. Literal queries are most efficient.",
      "Use path for include ('src/', '*.ts') and exclude for noise ('test/,*.min.js').",
      "caseSensitive: true when you need exact case (smart-case otherwise).",
      "After 1-2 greps, read the top match instead of more greps.",
    ],
    parameters: grepSchema,

    async execute(_toolCallId, params, signal) {
      if (signal?.aborted === true) throw new Error("Operation aborted");
      const startedAt = nowMs();

      const f = await runtime.ensureFinder(runtime.getActiveCwd());
      const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
      const query = buildToolQuery({
        tool: "grep",
        path: params.path,
        pattern: params.pattern,
        exclude: params.exclude,
        cwd: runtime.getActiveCwd(),
      });
      // Auto-detect: regex if the pattern has regex metacharacters AND parses
      // as a valid regex, otherwise plain literal. The fuzzy fallback below
      // only kicks in for plain mode — regex queries are intentional.
      const hasRegexSyntax =
        params.pattern !== params.pattern.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
      let mode: GrepMode = hasRegexSyntax ? "regex" : "plain";
      if (mode === "regex") {
        try {
          new RegExp(params.pattern).test("");
        } catch {
          mode = "plain";
        }
      }

      // Guard: the agent keeps calling grep with '.*' or similar wildcard-only regex
      // to try to read a whole file. That's not what grep is for — return a terse error
      // steering them to a real pattern, preventing dozens of wasted retries.
      const p = params.pattern.trim();
      const isWildcardOnly =
        hasRegexSyntax &&
        /^(?:[.^$]*(?:[.][*+?]|\*|\+)[.^$]*|[.^$\s]*|\.\*\??|\.\*[+?]?|\.\+\??|\.|\*|\?)$/.test(p);

      if (isWildcardOnly) {
        return {
          content: [
            {
              type: "text",
              text: `Pattern '${params.pattern}' matches everything — grep needs a concrete substring or identifier. Example: \`pattern: 'MyClass'\` or \`pattern: 'export function'\`.`,
            },
          ],
          details: {
            totalMatched: 0,
            totalFiles: 0,
            elapsedMs: nowMs() - startedAt,
            query: params.pattern,
            path: params.path,
          },
        };
      }

      // caseSensitive override flips smartCase off; omitting it keeps smart-case
      // (case-insensitive when pattern is all lowercase).
      const smartCase = params.caseSensitive !== true;

      const grepResult = f.grep(query, {
        mode,
        smartCase,
        maxMatchesPerFile: Math.min(effectiveLimit, 50),
        cursor:
          (params.cursor !== undefined && params.cursor.length > 0
            ? getCursor(params.cursor)
            : null) ?? null,
        beforeContext: params.context ?? 0,
        afterContext: params.context ?? 0,
        classifyDefinitions: true,
      });

      if (!grepResult.ok) throw new Error(grepResult.error);

      let result = grepResult.value;
      let fuzzyNotice: string | null = null;

      // automatic fuzzy fallback allows to broad the queries and find different cases
      if (
        result.items.length === 0 &&
        (params.cursor === undefined || params.cursor.length === 0) &&
        mode !== "regex"
      ) {
        const fuzzy = f.grep(params.pattern, {
          mode: "fuzzy",
          smartCase,
          maxMatchesPerFile: Math.min(effectiveLimit, 50),
          cursor: null,
          beforeContext: 0,
          afterContext: 0,
          classifyDefinitions: true,
        });

        if (fuzzy.ok && fuzzy.value.items.length > 0) {
          fuzzyNotice = `0 exact matches. Maybe you meant this?`;
          result = fuzzy.value;
        }
      }

      let output = formatGrepOutput(result);
      const notices: string[] = [];
      if (result.regexFallbackError !== undefined && result.regexFallbackError.length > 0) {
        notices.push(`Invalid regex: ${result.regexFallbackError}, used literal match`);
      }
      if (result.nextCursor !== undefined && result.nextCursor !== null) {
        notices.push(`Continue with cursor="${storeCursor(result.nextCursor)}"`);
      }

      if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
      if (fuzzyNotice !== null) output = `[${fuzzyNotice}]\n${output}`;

      return {
        content: [{ type: "text", text: output }],
        details: {
          totalMatched: result.totalMatched,
          totalFiles: result.totalFiles,
          elapsedMs: nowMs() - startedAt,
          query: params.pattern,
          path: params.path,
        },
      };
    },

    renderCall(args, theme, context) {
      return renderSearchCall("grep", args ?? {}, theme, context);
    },

    renderResult(result, options, theme, context) {
      return renderSearchResult(result, options, theme, context);
    },
  });
}

function registerFindTool(pi: ExtensionAPI, runtime: FffToolRuntime): void {
  pi.registerTool({
    name: TOOL_NAMES.find,
    label: TOOL_NAMES.find,
    renderShell: "self",
    description: `Fuzzy path search and glob search. Matches against the whole repo-relative path, not just the filename. Frecency-ranked, git-aware. Multi-word = narrower (AND). Default limit ${DEFAULT_FIND_LIMIT}.`,
    promptSnippet: "Find files by path or glob",
    promptGuidelines: [
      "Matches the WHOLE path, not just the filename — `profile` hits `chrome/browser/profiles/x.cc` too.",
      "Keep queries to 1-2 terms; extra words narrow.",
      "Use for paths, not content. Use grep for content.",
      "For exact path matches use a glob in `path` — e.g. path: '**/profile.h' for exact filename, or path: 'src/**/profile.h' scoped to a subtree. Bare patterns are fuzzy.",
      "To list everything inside a directory, pass path: 'dir/**' with an empty or wildcard pattern instead of using pattern alone.",
      "Use exclude: 'test/,*.min.js' to cut noise in large repos.",
    ],
    parameters: findSchema,

    async execute(_toolCallId, params, signal) {
      if (signal?.aborted === true) throw new Error("Operation aborted");
      const startedAt = nowMs();

      const f = await runtime.ensureFinder(runtime.getActiveCwd());

      // Resume from a prior cursor if supplied — cursor owns query+pageSize so
      // the agent can't accidentally mix patterns across pages.
      const resumed =
        params.cursor !== undefined && params.cursor.length > 0
          ? getFindCursor(params.cursor)
          : undefined;
      const effectiveLimit = resumed
        ? resumed.pageSize
        : Math.max(1, params.limit ?? DEFAULT_FIND_LIMIT);
      const query = resumed
        ? resumed.query
        : buildToolQuery({
            tool: "find",
            path: params.path,
            pattern: params.pattern,
            exclude: params.exclude,
            cwd: runtime.getActiveCwd(),
          });
      const pattern = resumed ? resumed.pattern : params.pattern;
      const pageIndex = resumed?.nextPageIndex ?? 0;

      const searchResult = f.fileSearch(query, {
        pageIndex,
        pageSize: effectiveLimit,
      });
      if (!searchResult.ok) throw new Error(searchResult.error);

      const result = searchResult.value;
      const formatted = formatFindOutput(result, effectiveLimit, pattern);
      let output = formatted.output;

      // Infer hasMore: native fileSearch fills pageSize when more results
      // exist, so if we got a full page AND totalMatched exceeds what we've
      // shown so far there's another page to fetch.
      const shownSoFar = pageIndex * effectiveLimit + result.items.length;
      const hasMore = result.items.length >= effectiveLimit && result.totalMatched > shownSoFar;

      const notices: string[] = [];
      if (formatted.weak && formatted.shownCount > 0)
        notices.push(
          `Query "${pattern}" produced only weak scattered fuzzy matches. Output capped at ${formatted.shownCount}/${result.totalMatched}.`,
        );

      if (!formatted.weak && hasMore) {
        const remaining = result.totalMatched - shownSoFar;
        const cursorId = storeFindCursor({
          query,
          pattern,
          pageSize: effectiveLimit,
          nextPageIndex: pageIndex + 1,
        });
        notices.push(
          `${remaining} more match${remaining === 1 ? "" : "es"} available. cursor="${cursorId}" to continue`,
        );
      }

      if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
      return {
        content: [{ type: "text", text: output }],
        details: {
          totalMatched: result.totalMatched,
          totalFiles: result.totalFiles,
          elapsedMs: nowMs() - startedAt,
          query: pattern,
          path: params.path,
          pageIndex,
          hasMore,
        },
      };
    },

    renderCall(args, theme, context) {
      return renderSearchCall("find", args ?? {}, theme, context);
    },

    renderResult(result, options, theme, context) {
      return renderSearchResult(result, options, theme, context);
    },
  });
}

export function registerSearchTools(pi: ExtensionAPI, runtime: FffToolRuntime): void {
  registerGrepTool(pi, runtime);
  registerFindTool(pi, runtime);
}
