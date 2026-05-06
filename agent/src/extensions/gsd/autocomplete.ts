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
  "map-codebase": ["--paths", "--paths="],
  "discuss-phase": ["--phase", "--phase="],
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
  if (value === "--diagnose") {
    return "Find root cause only";
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
