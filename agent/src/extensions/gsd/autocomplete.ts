import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fuzzyFilter, type AutocompleteItem } from "@mariozechner/pi-tui";
import type { GsdSubcommand } from "./commands.js";
import { getLastKnownGsdCwd } from "./state/cwd.js";
import {
  getGsdDebugSuggestions,
  getGsdMilestoneSuggestions,
  getGsdPhaseSuggestions,
  getGsdSubcommandHint,
} from "./state/suggestions.js";

const subcommands: Array<{ value: GsdSubcommand; description: string }> = [
  { value: "new-project", description: "Bootstrap .planning" },
  { value: "new-milestone", description: "Start next milestone cycle" },
  { value: "complete-milestone", description: "Archive active milestone" },
  { value: "milestone-summary", description: "Write milestone report" },
  { value: "debug", description: "Persisted debug workflow" },
  { value: "map-codebase", description: "Map existing codebase" },
  { value: "discuss-phase", description: "Create phase context" },
  { value: "plan-phase", description: "Plan current phase" },
  { value: "execute-phase", description: "Run delegated execution" },
  { value: "verify-work", description: "Run delegated verification" },
  { value: "validate-phase", description: "Write validation artifact" },
  { value: "next", description: "Advance current plan pointer" },
  { value: "progress", description: "Show progress" },
  { value: "stats", description: "Show stats" },
  { value: "health", description: "Show .planning health" },
  { value: "status", description: "Show live subagent status panel" },
  { value: "help", description: "Show help" },
  { value: "on", description: "Enable GSD" },
  { value: "off", description: "Disable GSD" },
];

const phaseAwareSubcommands: GsdSubcommand[] = [
  "discuss-phase",
  "plan-phase",
  "execute-phase",
  "verify-work",
  "validate-phase",
  "next",
];

const subcommandFlags: Partial<Record<GsdSubcommand, string[]>> = {
  "discuss-phase": ["--phase", "--phase=", "--assumptions", "--auto", "--all", "--chain", "--text"],
  "plan-phase": ["--phase", "--phase="],
  "execute-phase": ["--phase", "--phase="],
  "verify-work": ["--phase", "--phase="],
  "validate-phase": ["--phase", "--phase="],
  next: ["--phase", "--phase="],
  debug: ["--diagnose"],
};

export function getGsdSubcommands(): Array<{ value: GsdSubcommand; description: string }> {
  return subcommands;
}

function filterItems(items: AutocompleteItem[], query: string): AutocompleteItem[] | null {
  if (items.length === 0) {
    return null;
  }
  if (query.length === 0) {
    return items;
  }
  const filtered = fuzzyFilter(items, query, (item) => `${item.label} ${item.value}`);
  return filtered.length > 0 ? filtered : null;
}

function getPhaseItems(prefixBase = "", flagPrefix?: "--phase="): AutocompleteItem[] {
  const cwd = getLastKnownGsdCwd();
  if (cwd === undefined) {
    return [];
  }
  return getGsdPhaseSuggestions(cwd).map((item) => ({
    value:
      flagPrefix === undefined
        ? `${prefixBase}${item.value}`
        : `${prefixBase}${flagPrefix}${item.value}`,
    label: item.label,
    description: item.description,
  }));
}

function getFlagItems(subcommand: GsdSubcommand, prefixBase = ""): AutocompleteItem[] {
  return (subcommandFlags[subcommand] ?? []).map((value) => ({
    value: `${prefixBase}${value}`,
    label: value,
    description: getFlagDescription(value),
  }));
}

function getMapCodebaseModeItems(prefixBase: string): AutocompleteItem[] {
  const cwd = getLastKnownGsdCwd();
  const skipAvailable = cwd !== undefined && hasReusableCodebaseBaseline(cwd);
  return [
    {
      value: `${prefixBase}refresh`,
      label: "refresh",
      description: "Replace canonical codebase map",
    },
    {
      value: `${prefixBase}update`,
      label: "update",
      description: "Refresh canonical codebase map in place",
    },
    {
      value: `${prefixBase}skip`,
      label: "skip",
      description: skipAvailable
        ? "Reuse current canonical codebase map"
        : "Unavailable until canonical map baseline is valid",
    },
  ];
}

function getMapCodebaseFastModeItems(prefixBase: string): AutocompleteItem[] {
  return [
    {
      value: `${prefixBase}refresh`,
      label: "refresh",
      description: "Overwrite only fast-scan target docs",
    },
  ];
}

function getMapCodebaseFastFlagItems(prefixBase: string): AutocompleteItem[] {
  return [
    {
      value: `${prefixBase}--fast`,
      label: "--fast",
      description: "Run partial non-canonical fast scan",
    },
  ];
}

function getMapCodebaseQueryFlagItems(prefixBase: string): AutocompleteItem[] {
  return [
    {
      value: `${prefixBase}--query`,
      label: "--query",
      description: "Run local intel query or refresh mode",
    },
    {
      value: `${prefixBase}--query=`,
      label: "--query=",
      description: "Inline local intel query or refresh mode",
    },
  ];
}

function getMapCodebaseQueryItems(prefixBase: string): AutocompleteItem[] {
  return [
    {
      value: `${prefixBase}query `,
      label: "query",
      description: "Escape hatch for freeform search terms like `status page`",
    },
    {
      value: `${prefixBase}status`,
      label: "status",
      description: "Show intel file status summary",
    },
    {
      value: `${prefixBase}diff`,
      label: "diff",
      description: "Show intel changes since baseline snapshot",
    },
    {
      value: `${prefixBase}refresh`,
      label: "refresh",
      description: "Run detached full intel refresh",
    },
  ];
}

function getMapCodebaseQueryModeCompletions(
  tokens: string[],
  token: string,
): AutocompleteItem[] | null {
  const queryIndex = tokens.findIndex(
    (value) => value === "--query" || value.startsWith("--query="),
  );
  if (queryIndex === -1) {
    return null;
  }

  const queryFlag = tokens[queryIndex];
  let queryTokens: string[];
  if (queryFlag.startsWith("--query=")) {
    queryTokens = [queryFlag.slice("--query=".length), ...tokens.slice(queryIndex + 1)];
  } else {
    queryTokens = tokens.slice(queryIndex + 1);
  }

  const firstQueryToken = queryTokens[0];
  if (firstQueryToken === undefined) {
    return filterItems(getMapCodebaseQueryItems("map-codebase --query "), token);
  }

  if (firstQueryToken === "query") {
    return null;
  }

  return null;
}

function getMapCodebaseFastFocusFlagItems(prefixBase: string): AutocompleteItem[] {
  return [
    {
      value: `${prefixBase}--focus`,
      label: "--focus",
      description: "Set fast-map focus area",
    },
    {
      value: `${prefixBase}--focus=`,
      label: "--focus=",
      description: "Inline fast-map focus area",
    },
  ];
}

function getMapCodebaseFocusItems(prefixBase: string, inline = false): AutocompleteItem[] {
  const focusValues = [
    {
      value: "tech",
      description: "Write STACK.md, INTEGRATIONS.md",
    },
    {
      value: "arch",
      description: "Write ARCHITECTURE.md, STRUCTURE.md",
    },
    {
      value: "quality",
      description: "Write CONVENTIONS.md, TESTING.md",
    },
    {
      value: "concerns",
      description: "Write CONCERNS.md",
    },
    {
      value: "tech+arch",
      description: "Write STACK.md, INTEGRATIONS.md, ARCHITECTURE.md, STRUCTURE.md",
    },
  ];

  return focusValues.map((item) => ({
    value: inline ? `${prefixBase}--focus=${item.value}` : `${prefixBase}${item.value}`,
    label: item.value,
    description: item.description,
  }));
}

function hasReusableCodebaseBaseline(cwd: string): boolean {
  const codebaseDir = join(cwd, ".planning", "codebase");
  const docs = [
    "STACK.md",
    "INTEGRATIONS.md",
    "ARCHITECTURE.md",
    "STRUCTURE.md",
    "CONVENTIONS.md",
    "TESTING.md",
    "CONCERNS.md",
  ];
  const frontmatterPattern = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u;
  const minimumArtifactBodyLines = 3;
  const minimumArtifactBodyCharacters = 40;
  const baselines = new Set<string>();
  for (const name of docs) {
    const path = join(codebaseDir, name);
    if (!existsSync(path)) {
      return false;
    }
    try {
      const content = readFileSync(path, "utf8");
      const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u, "").trim();
      if (body.length < minimumArtifactBodyCharacters) {
        return false;
      }
      const substantiveLines = body
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      if (substantiveLines.length < minimumArtifactBodyLines) {
        return false;
      }
      const match = content.match(frontmatterPattern);
      const mappedCommit = match?.[1]
        .split(/\r?\n/u)
        .map((line) => line.match(/^last_mapped_commit:\s*(.+)$/u)?.[1]?.trim())
        .find((value) => value !== undefined);
      if (mappedCommit === undefined || mappedCommit.length === 0) {
        return false;
      }
      execFileSync("git", ["cat-file", "-t", mappedCommit], {
        cwd,
        stdio: ["ignore", "ignore", "ignore"],
      });
      execFileSync("git", ["merge-base", "--is-ancestor", mappedCommit, "HEAD"], {
        cwd,
        stdio: ["ignore", "ignore", "ignore"],
      });
      baselines.add(mappedCommit);
    } catch {
      return false;
    }
  }
  return baselines.size === 1;
}

function getDebugActionItems(prefixBase: string): AutocompleteItem[] {
  return [
    {
      value: `${prefixBase}list`,
      label: "list",
      description: "List active sessions",
    },
    {
      value: `${prefixBase}status `,
      label: "status",
      description: "Inspect session by slug",
    },
    {
      value: `${prefixBase}continue `,
      label: "continue",
      description: "Resume session by slug",
    },
  ];
}

function getDebugSessionItems(prefixBase: string, cwd: string | undefined): AutocompleteItem[] {
  if (cwd === undefined) {
    return [];
  }
  return getGsdDebugSuggestions(cwd)
    .filter((item) => item.value !== "list" && item.value !== "status" && item.value !== "continue")
    .map((item) => ({
      value: `${prefixBase}${item.value}`,
      label: item.label,
      description: item.description,
    }));
}

function getFlagDescription(value: string): string | undefined {
  if (value === "--phase") {
    return "Override target phase";
  }
  if (value === "--phase=") {
    return "Inline phase override";
  }
  if (value === "--paths") {
    return "Scope mapping to repo-relative paths";
  }
  if (value === "--paths=") {
    return "Inline repo-relative mapping paths";
  }
  if (value === "--fast") {
    return "Run partial non-canonical fast scan";
  }
  if (value === "--focus") {
    return "Set fast-map focus area";
  }
  if (value === "--focus=") {
    return "Inline fast-map focus area";
  }
  if (value === "--query") {
    return "Intel query or refresh mode";
  }
  if (value === "--query=") {
    return "Inline intel query or refresh mode";
  }
  if (value === "--diagnose") {
    return "Find root cause only";
  }
  if (value === "--assumptions") {
    return "Route to assumptions discuss mode";
  }
  if (value === "--auto") {
    return "Allow automated completion when safe";
  }
  if (value === "--all") {
    return "Cover all detected gray areas";
  }
  if (value === "--chain") {
    return "Record plan-phase handoff after completion";
  }
  if (value === "--text") {
    return "Use text-only discuss transport";
  }
  return undefined;
}

function getTrailingToken(prefix: string): {
  trimmed: string;
  token: string;
  trailingSpace: boolean;
} {
  const trailingSpace = /\s$/u.test(prefix);
  const trimmed = prefix.trimStart();
  if (trailingSpace) {
    return { trimmed, token: "", trailingSpace };
  }
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  return { trimmed, token: tokens.at(-1) ?? "", trailingSpace };
}

export function getGsdArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  const cwd = getLastKnownGsdCwd();
  const items = subcommands.map((item) => {
    const hint = cwd === undefined ? undefined : getGsdSubcommandHint(cwd, item.value);
    return {
      value: item.value,
      label: item.value,
      description: hint === undefined ? item.description : `${item.description} • ${hint}`,
    };
  });

  const { trimmed, token, trailingSpace } = getTrailingToken(prefix);
  if (trimmed.length === 0) {
    return items;
  }
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return items;
  }

  if (tokens.length === 1 && !trailingSpace) {
    return filterItems(items, token);
  }

  const subcommand = subcommands.find((item) => item.value === tokens[0])?.value;
  if (subcommand === undefined) {
    return filterItems(items, token);
  }

  if (subcommand === "debug") {
    const debugActionItems = getDebugActionItems("debug ");
    const debugSessionItems = getDebugSessionItems(`debug ${tokens[1]} `, cwd);
    if (token.startsWith("--")) {
      return filterItems(getFlagItems(subcommand, "debug "), token);
    }
    if (tokens[1] === "status" || tokens[1] === "continue") {
      return filterItems(debugSessionItems, token);
    }
    if (tokens.length === 1 && trailingSpace) {
      return [...debugActionItems, ...getFlagItems(subcommand, "debug ")];
    }
    if (tokens.length <= 2) {
      return filterItems([...debugActionItems, ...getFlagItems(subcommand, "debug ")], token);
    }
  }

  if (subcommand === "complete-milestone" || subcommand === "milestone-summary") {
    const milestoneItems = (cwd === undefined ? [] : getGsdMilestoneSuggestions(cwd)).map(
      (item) => ({
        value: `${subcommand} ${item.value}`,
        label: item.label,
        description: item.description,
      }),
    );
    if (trailingSpace && tokens.length === 1) {
      return milestoneItems;
    }
    if (tokens.length === 2) {
      return filterItems(milestoneItems, token);
    }
  }

  if (subcommand === "map-codebase") {
    const modeItems = getMapCodebaseModeItems("map-codebase ");
    const fastModeItems = getMapCodebaseFastModeItems("map-codebase --fast ");
    const fastFlagItems = getMapCodebaseFastFlagItems("map-codebase ");
    const queryFlagItems = getMapCodebaseQueryFlagItems("map-codebase ");
    const fastFocusFlagItems = getMapCodebaseFastFocusFlagItems("map-codebase --fast ");
    const inFastMode = tokens.includes("--fast");
    const inQueryMode = tokens.includes("--query") || token.startsWith("--query=");
    const previousToken = trailingSpace ? tokens.at(-1) : tokens.at(-2);
    if (previousToken === "--query") {
      return filterItems(getMapCodebaseQueryItems("map-codebase --query "), token);
    }
    if (token.startsWith("--query=")) {
      return filterItems(getMapCodebaseQueryItems("map-codebase --query="), token);
    }
    if (inQueryMode) {
      return getMapCodebaseQueryModeCompletions(tokens, token);
    }
    if (previousToken === "--focus") {
      if (!inFastMode) {
        return null;
      }
      return filterItems(getMapCodebaseFocusItems("map-codebase --fast --focus "), token);
    }
    if (trailingSpace && tokens.length === 1) {
      return [...modeItems, ...fastFlagItems, ...queryFlagItems];
    }
    if (token.startsWith("--focus=")) {
      if (!inFastMode) {
        return null;
      }
      return filterItems(getMapCodebaseFocusItems("map-codebase --fast ", true), token);
    }
    if (inFastMode && trailingSpace) {
      return [...fastModeItems, ...fastFocusFlagItems];
    }
    if (tokens.length === 2) {
      return filterItems([...modeItems, ...fastFlagItems, ...queryFlagItems], token);
    }
    if (inFastMode) {
      if (token.startsWith("--")) {
        return filterItems(fastFocusFlagItems, token);
      }
      return filterItems(fastModeItems, token);
    }
  }

  if (token.startsWith("--phase=")) {
    return filterItems(getPhaseItems(`${subcommand} `, "--phase="), token);
  }

  if (token.startsWith("--")) {
    return filterItems(getFlagItems(subcommand, `${subcommand} `), token);
  }

  const phaseItems = phaseAwareSubcommands.includes(subcommand)
    ? getPhaseItems(`${subcommand} `)
    : [];
  if (phaseItems.length > 0) {
    const previousToken = trailingSpace ? tokens.at(-1) : tokens.at(-2);
    if (previousToken === "--phase") {
      return filterItems(getPhaseItems(`${subcommand} --phase `), token);
    }
    if (trailingSpace) {
      return [...phaseItems, ...getFlagItems(subcommand, `${subcommand} `)];
    }
    if (!token.startsWith("-")) {
      return filterItems(phaseItems, token);
    }
  }

  if (trailingSpace) {
    return getFlagItems(subcommand, `${subcommand} `);
  }

  return filterItems(getFlagItems(subcommand, `${subcommand} `), token);
}
