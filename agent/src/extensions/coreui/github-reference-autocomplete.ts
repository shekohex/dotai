import type { ExecResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const MAX_RESULTS_PER_KIND = 20;
const CACHE_TTL_MS = 30_000;
const GH_TIMEOUT_MS = 5_000;
const SEARCH_DEBOUNCE_MS = 250;

const GitHubReferenceSchema = Type.Object({
  number: Type.Number(),
  title: Type.String(),
  state: Type.String(),
  url: Type.String(),
  updatedAt: Type.String(),
  isDraft: Type.Optional(Type.Boolean()),
});

const GitHubReferenceListSchema = Type.Array(GitHubReferenceSchema);

type GitHubReference = Static<typeof GitHubReferenceSchema>;
type GitHubReferenceKind = "issue" | "pr";
type GitHubReferenceState = "open" | "closed";
type ExecFunction = ExtensionAPI["exec"];
type Theme = ExtensionContext["ui"]["theme"];

type GitHubReferenceAutocompleteDeps = {
  current: AutocompleteProvider;
  exec: ExecFunction;
  cwd: string;
  theme: Theme;
  notify?: (message: string, type?: "info" | "warning" | "error") => void;
};

type GitHubReferenceSearchDeps = {
  exec: ExecFunction;
  cwd: string;
  theme: Theme;
  notify?: (message: string, type?: "info" | "warning" | "error") => void;
};

type GitHubReferenceSearchState = {
  repo?: string;
  repoCheckedAt?: number;
  warningShown?: boolean;
  cache: Map<string, { expiresAt: number; items: AutocompleteItem[] }>;
};

function extractGitHubReferenceToken(textBeforeCursor: string): string | undefined {
  const match = textBeforeCursor.match(/(?:^|[ \t])#([^\s#]*)$/);
  return match?.[1];
}

function parseJsonReferences(stdout: string): GitHubReference[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }

  if (!Value.Check(GitHubReferenceListSchema, parsed)) {
    return [];
  }

  return Value.Parse(GitHubReferenceListSchema, parsed);
}

function normalizeGhState(state: string): string {
  return state.toLowerCase();
}

function formatState(theme: Theme, reference: GitHubReference): string {
  if (reference.isDraft === true) {
    return theme.fg("warning", "draft");
  }

  const state = normalizeGhState(reference.state);
  if (state === "open") {
    return theme.fg("success", "open");
  }
  if (state === "closed") {
    return theme.fg("error", "closed");
  }
  if (state === "merged") {
    return theme.fg("accent", "merged");
  }
  return theme.fg("muted", state);
}

function formatKind(theme: Theme, kind: GitHubReferenceKind): string {
  return kind === "pr" ? theme.fg("accent", "PR") : theme.fg("warning", "issue");
}

function formatReferenceItem(
  theme: Theme,
  kind: GitHubReferenceKind,
  reference: GitHubReference,
): AutocompleteItem {
  return {
    value: `#${reference.number}`,
    label: reference.title,
    description: `#${reference.number} ${formatKind(theme, kind)} ${formatState(theme, reference)}`,
  };
}

function compareReferencesByUpdatedAt(a: GitHubReference, b: GitHubReference): number {
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}

function dedupeItems(items: AutocompleteItem[]): AutocompleteItem[] {
  const seen = new Set<string>();
  const result: AutocompleteItem[] = [];
  for (const item of items) {
    if (seen.has(item.value)) {
      continue;
    }
    seen.add(item.value);
    result.push(item);
  }
  return result;
}

async function execGh(
  exec: ExecFunction,
  cwd: string,
  args: string[],
  signal: AbortSignal,
): Promise<ExecResult | undefined> {
  try {
    return await exec("gh", args, { cwd, signal, timeout: GH_TIMEOUT_MS });
  } catch {
    return undefined;
  }
}

async function execGit(
  exec: ExecFunction,
  cwd: string,
  args: string[],
  signal: AbortSignal,
): Promise<ExecResult | undefined> {
  try {
    return await exec("git", args, { cwd, signal, timeout: GH_TIMEOUT_MS });
  } catch {
    return undefined;
  }
}

function parseGitHubRepoFromRemote(remoteUrl: string): string | undefined {
  const trimmed = remoteUrl.trim();
  const match = trimmed.match(
    /(?:github\.com[:/]|https?:\/\/github\.com\/)([^/\s:]+)\/([^/\s]+?)(?:\.git)?$/,
  );
  if (match === null) {
    return undefined;
  }

  return `${match[1]}/${match[2]}`;
}

async function resolveGitHubRepoFromGitRemote(
  deps: GitHubReferenceSearchDeps,
  signal: AbortSignal,
): Promise<string | undefined> {
  const result = await execGit(deps.exec, deps.cwd, ["remote", "-v"], signal);
  if (result === undefined || result.code !== 0) {
    return undefined;
  }

  for (const line of result.stdout.split("\n")) {
    const remoteUrl = line.trim().split(/\s+/)[1];
    if (remoteUrl === undefined) {
      continue;
    }
    const repo = parseGitHubRepoFromRemote(remoteUrl);
    if (repo !== undefined) {
      return repo;
    }
  }

  return undefined;
}

function waitForSearchDebounce(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, SEARCH_DEBOUNCE_MS);

    const onAbort = (): void => {
      clearTimeout(timeout);
      resolve(false);
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function showWarningOnce(
  state: GitHubReferenceSearchState,
  notify: GitHubReferenceSearchDeps["notify"],
  message: string,
): void {
  if (state.warningShown === true) {
    return;
  }
  state.warningShown = true;
  notify?.(message, "warning");
}

async function resolveGitHubRepo(
  deps: GitHubReferenceSearchDeps,
  state: GitHubReferenceSearchState,
  signal: AbortSignal,
): Promise<string | undefined> {
  const now = Date.now();
  if (state.repo !== undefined) {
    return state.repo;
  }
  if (state.repoCheckedAt !== undefined && now - state.repoCheckedAt < CACHE_TTL_MS) {
    return undefined;
  }

  state.repoCheckedAt = now;
  const gitRemoteRepo = await resolveGitHubRepoFromGitRemote(deps, signal);
  if (gitRemoteRepo !== undefined) {
    state.repo = gitRemoteRepo;
    return gitRemoteRepo;
  }

  const result = await execGh(
    deps.exec,
    deps.cwd,
    ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
    signal,
  );
  if (result === undefined || result.code !== 0) {
    const stderr = result?.stderr.trim() ?? "";
    const stdout = result?.stdout.trim() ?? "";
    let details = "gh unavailable or not authenticated";
    if (stdout.length > 0) {
      details = stdout;
    }
    if (stderr.length > 0) {
      details = stderr;
    }
    showWarningOnce(state, deps.notify, `GitHub autocomplete disabled: ${details}`);
    return undefined;
  }

  const repo = result.stdout.trim();
  if (repo.length === 0) {
    showWarningOnce(
      state,
      deps.notify,
      "GitHub autocomplete disabled: current directory is not a GitHub repository",
    );
    return undefined;
  }

  state.repo = repo;
  return repo;
}

function buildSearchArgs(
  kind: GitHubReferenceKind,
  repo: string,
  query: string,
  state: GitHubReferenceState,
): string[] {
  const command = kind === "pr" ? "prs" : "issues";
  const fields =
    kind === "pr" ? "number,title,state,url,updatedAt,isDraft" : "number,title,state,url,updatedAt";
  return [
    "search",
    command,
    query,
    "--repo",
    repo,
    "--state",
    state,
    "--limit",
    String(MAX_RESULTS_PER_KIND),
    "--json",
    fields,
  ];
}

async function searchReferencesByKind(
  deps: GitHubReferenceSearchDeps,
  repo: string,
  query: string,
  kind: GitHubReferenceKind,
  state: GitHubReferenceState,
  signal: AbortSignal,
): Promise<AutocompleteItem[]> {
  const result = await execGh(
    deps.exec,
    deps.cwd,
    buildSearchArgs(kind, repo, query, state),
    signal,
  );
  if (result === undefined || result.code !== 0 || signal.aborted) {
    return [];
  }

  return parseJsonReferences(result.stdout)
    .toSorted(compareReferencesByUpdatedAt)
    .map((reference) => formatReferenceItem(deps.theme, kind, reference));
}

async function searchGitHubReferences(
  deps: GitHubReferenceSearchDeps,
  state: GitHubReferenceSearchState,
  query: string,
  signal: AbortSignal,
): Promise<AutocompleteItem[]> {
  const cacheKey = query.trim().toLowerCase();
  const cached = state.cache.get(cacheKey);
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    return cached.items;
  }

  const repo = await resolveGitHubRepo(deps, state, signal);
  if (repo === undefined || signal.aborted) {
    return [];
  }

  const shouldSearch = await waitForSearchDebounce(signal);
  if (!shouldSearch) {
    return [];
  }

  const [openIssueItems, closedIssueItems, openPrItems, closedPrItems] = await Promise.all([
    searchReferencesByKind(deps, repo, query, "issue", "open", signal),
    searchReferencesByKind(deps, repo, query, "issue", "closed", signal),
    searchReferencesByKind(deps, repo, query, "pr", "open", signal),
    searchReferencesByKind(deps, repo, query, "pr", "closed", signal),
  ]);
  if (signal.aborted) {
    return [];
  }

  const items = dedupeItems([
    ...openPrItems,
    ...openIssueItems,
    ...closedPrItems,
    ...closedIssueItems,
  ]).slice(0, MAX_RESULTS_PER_KIND);
  state.cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, items });
  return items;
}

export function createGitHubReferenceAutocompleteProvider(
  deps: GitHubReferenceAutocompleteDeps,
): AutocompleteProvider {
  const state: GitHubReferenceSearchState = { cache: new Map() };

  return {
    triggerCharacters: ["#"],

    async getSuggestions(
      lines,
      cursorLine,
      cursorCol,
      options,
    ): Promise<AutocompleteSuggestions | null> {
      const line = lines[cursorLine] ?? "";
      const token = extractGitHubReferenceToken(line.slice(0, cursorCol));
      if (token === undefined) {
        return deps.current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      const items = await searchGitHubReferences(deps, state, token, options.signal);
      if (options.signal.aborted || items.length === 0) {
        return deps.current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      return {
        prefix: `#${token}`,
        items,
      };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return deps.current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return deps.current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

export function registerGitHubReferenceAutocomplete(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (!ctx.hasUI || typeof ctx.ui.addAutocompleteProvider !== "function") {
    return;
  }

  ctx.ui.addAutocompleteProvider((current) =>
    createGitHubReferenceAutocompleteProvider({
      current,
      exec: (command, args, options) => pi.exec(command, args, options),
      cwd: ctx.cwd,
      theme: ctx.ui.theme,
      notify: (message, type) => {
        ctx.ui.notify(message, type);
      },
    }),
  );
}

export const __githubReferenceAutocompleteTest = {
  extractGitHubReferenceToken,
  parseJsonReferences,
  parseGitHubRepoFromRemote,
};
