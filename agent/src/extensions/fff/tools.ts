import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FileFinderApi, GrepCursor, GrepMode, GrepResult } from "@ff-labs/fff-node";
import { Type } from "typebox";
import {
  DEFAULT_FIND_LIMIT,
  DEFAULT_GREP_LIMIT,
  GREP_CONTEXT_MAX,
  GREP_PAGE_SIZE_MAX,
  GREP_TIME_BUDGET_MS,
  TOOL_NAMES,
} from "./constants.js";
import { formatFindOutput, formatGrepOutput } from "./format.js";
import { nowMs, renderSearchCall, renderSearchResult } from "./render.js";
import type { FffToolRuntime } from "./types.js";
import { buildQuery } from "./query.js";

// ---------------------------------------------------------------------------
// Cursor store — simple bounded Map for pagination cursors
// ---------------------------------------------------------------------------

interface SearchCursorStore {
  grep: Map<string, GrepCursorRecord>;
  grepCounter: number;
  find: Map<string, FindCursor>;
  findCounter: number;
}

interface GrepCursorRecord {
  cursor: GrepCursor;
  path?: string;
  pattern: string;
  exclude?: string | string[];
}

function storeCursor(store: SearchCursorStore, record: GrepCursorRecord): string {
  const id = `fff_c${++store.grepCounter}`;
  store.grep.set(id, record);
  if (store.grep.size > 200) {
    const first = store.grep.keys().next().value;
    if (first !== undefined) store.grep.delete(first);
  }
  return id;
}

function getCursor(store: SearchCursorStore, id: string): GrepCursorRecord | undefined {
  return store.grep.get(id);
}

function getCursorRecord(
  store: SearchCursorStore,
  cursorId: string | undefined,
): GrepCursorRecord | undefined {
  return cursorId === undefined || cursorId.length === 0 ? undefined : getCursor(store, cursorId);
}

// Find pagination uses a page-index cursor: native `fileSearch` takes
// pageIndex/pageSize, so the cursor is just the next page index paired with
// the query+limit that produced it. Stored tokens are opaque IDs to the agent.
interface FindCursor {
  query: string;
  pattern: string;
  pageSize: number;
  nextPageIndex: number;
  path?: string;
  exclude?: string | string[];
}

function storeFindCursor(store: SearchCursorStore, cursor: FindCursor): string {
  const id = `${++store.findCounter}`;
  store.find.set(id, cursor);
  if (store.find.size > 200) {
    const first = store.find.keys().next().value;
    if (first !== undefined) store.find.delete(first);
  }
  return id;
}

function getFindCursor(store: SearchCursorStore, id: string): FindCursor | undefined {
  return store.find.get(id);
}

function clampContext(context: number | undefined): number {
  if (context === undefined || context < 0) return 0;
  return Math.min(Math.floor(context), GREP_CONTEXT_MAX);
}

function runFuzzyFallback(input: {
  finder: FileFinderApi;
  pattern: string;
  path: string | undefined;
  query: string;
  smartCase: boolean;
  pageSize: number;
}): GrepResult | null {
  const lastSegment = input.path?.split(/[\\/]/).pop() ?? "";
  const pathTargetsFile = /\.[a-zA-Z][a-zA-Z0-9]{0,9}$/.test(lastSegment);
  const fuzzy = input.finder.grep(pathTargetsFile ? input.pattern : input.query, {
    mode: "fuzzy",
    smartCase: input.smartCase,
    maxMatchesPerFile: input.pageSize,
    pageSize: input.pageSize,
    cursor: null,
    beforeContext: 0,
    afterContext: 0,
    classifyDefinitions: true,
    timeBudgetMs: GREP_TIME_BUDGET_MS,
  });
  return fuzzy.ok && fuzzy.value.items.length > 0 ? fuzzy.value : null;
}

function isWildcardOnlyPattern(pattern: string, hasRegexSyntax: boolean): boolean {
  return (
    hasRegexSyntax &&
    /^(?:[.^$]*(?:[.][*+?]|\*|\+)[.^$]*|[.^$\s]*|\.\*\??|\.\*[+?]?|\.\+\??|\.|\*|\?)$/.test(
      pattern.trim(),
    )
  );
}

function detectGrepMode(pattern: string): { hasRegexSyntax: boolean; mode: GrepMode } {
  const hasRegexSyntax = pattern !== pattern.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let mode: GrepMode = hasRegexSyntax ? "regex" : "plain";
  if (mode === "regex") {
    try {
      new RegExp(pattern).test("");
    } catch {
      mode = "plain";
    }
  }
  return { hasRegexSyntax, mode };
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
        "Path constraint. Directory prefix (src/ or src/foo/), bare filename with extension (main.rs), or glob (*.ts, src/**/*.cc, {src,lib}/**). Absolute, ~/, and ../ paths outside the workspace use a separate index.",
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
  context: Type.Optional(
    Type.Number({
      description: `Context lines before+after each match (0-${GREP_CONTEXT_MAX})`,
    }),
  ),
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
        "Path constraint. Directory prefix (src/ or src/foo/), bare filename with extension (main.rs), or glob (*.ts, src/**/*.cc, {src,lib}/**). Absolute, ~/, and ../ paths outside the workspace use a separate index.",
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

function registerGrepTool(
  pi: ExtensionAPI,
  runtime: FffToolRuntime,
  cursorStore: SearchCursorStore,
): void {
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
      const cursorRecord = getCursorRecord(cursorStore, params.cursor);

      const resolved = await runtime.resolveFinderForPath(
        cursorRecord?.path ?? params.path,
        cursorRecord?.pattern ?? params.pattern,
        cursorRecord?.exclude ?? params.exclude,
      );
      const f = resolved?.finder ?? (await runtime.ensureFinder(runtime.getActiveCwd()));
      const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
      const pageSize = Math.min(effectiveLimit, GREP_PAGE_SIZE_MAX);
      const query =
        resolved?.query ??
        buildToolQuery({
          tool: "grep",
          path: params.path,
          pattern: params.pattern,
          exclude: params.exclude,
          cwd: runtime.getActiveCwd(),
        });
      const { hasRegexSyntax, mode } = detectGrepMode(params.pattern);

      if (isWildcardOnlyPattern(params.pattern, hasRegexSyntax)) {
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

      const smartCase = params.caseSensitive !== true;

      const grepResult = f.grep(query, {
        mode,
        smartCase,
        maxMatchesPerFile: pageSize,
        pageSize,
        cursor: cursorRecord?.cursor ?? null,
        beforeContext: clampContext(params.context),
        afterContext: clampContext(params.context),
        classifyDefinitions: true,
        timeBudgetMs: GREP_TIME_BUDGET_MS,
      });

      if (!grepResult.ok) throw new Error(grepResult.error);

      let result = grepResult.value;
      let fuzzyNotice: string | null = null;

      if (
        result.items.length === 0 &&
        (result.nextCursor === undefined || result.nextCursor === null) &&
        (params.cursor === undefined || params.cursor.length === 0) &&
        mode !== "regex"
      ) {
        const fuzzy = runFuzzyFallback({
          finder: f,
          pattern: params.pattern,
          path: params.path,
          query,
          smartCase,
          pageSize,
        });

        if (fuzzy !== null) {
          fuzzyNotice = `0 exact matches. Maybe you meant this?`;
          result = fuzzy;
        }
      }

      let output = formatGrepOutput(result);
      const notices: string[] = [];
      if (result.regexFallbackError !== undefined && result.regexFallbackError.length > 0) {
        notices.push(`Invalid regex: ${result.regexFallbackError}, used literal match`);
      }
      if (result.nextCursor !== undefined && result.nextCursor !== null) {
        notices.push(
          `Continue with cursor="${storeCursor(cursorStore, {
            cursor: result.nextCursor,
            path: cursorRecord?.path ?? params.path,
            pattern: cursorRecord?.pattern ?? params.pattern,
            exclude: cursorRecord?.exclude ?? params.exclude,
          })}"`,
        );
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

function registerFindTool(
  pi: ExtensionAPI,
  runtime: FffToolRuntime,
  cursorStore: SearchCursorStore,
): void {
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

      // Resume from a prior cursor if supplied — cursor owns query+pageSize so
      // the agent can't accidentally mix patterns across pages.
      const resumed =
        params.cursor !== undefined && params.cursor.length > 0
          ? getFindCursor(cursorStore, params.cursor)
          : undefined;
      const resolved = await runtime.resolveFinderForPath(
        resumed?.path ?? params.path,
        resumed?.pattern ?? params.pattern,
        resumed?.exclude ?? params.exclude,
      );
      const f = resolved?.finder ?? (await runtime.ensureFinder(runtime.getActiveCwd()));
      const effectiveLimit = resumed
        ? resumed.pageSize
        : Math.max(1, params.limit ?? DEFAULT_FIND_LIMIT);
      const query = resumed
        ? resumed.query
        : (resolved?.query ??
          buildToolQuery({
            tool: "find",
            path: params.path,
            pattern: params.pattern,
            exclude: params.exclude,
            cwd: runtime.getActiveCwd(),
          }));
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
        const cursorId = storeFindCursor(cursorStore, {
          query,
          pattern,
          pageSize: effectiveLimit,
          nextPageIndex: pageIndex + 1,
          path: resumed?.path ?? params.path,
          exclude: resumed?.exclude ?? params.exclude,
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
  const cursorStore: SearchCursorStore = {
    grep: new Map(),
    grepCounter: 0,
    find: new Map(),
    findCounter: 0,
  };
  registerGrepTool(pi, runtime, cursorStore);
  registerFindTool(pi, runtime, cursorStore);
}
