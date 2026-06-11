import {
  getAgentDir,
  loadSkills,
  type ExtensionAPI,
  type ExtensionContext,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import {
  fuzzyFilter,
  type AutocompleteItem,
  type AutocompleteProvider,
} from "@earendil-works/pi-tui";
import { discoverSkillPaths } from "../bundled-resources.js";

const MAX_AUTOCOMPLETE_ITEMS = 40;
const SKILL_MENTION_REGEX = /(^|[\s([{"'])(\$([A-Za-z0-9_.-]+))/g;

export const SKILL_REFERENCE_EXPANSION_MESSAGE = "skill-reference-expansion";

type SkillReferenceRuntimeState = {
  skills: Skill[];
  byName: Map<string, Skill>;
};

export type SkillReferenceMention = {
  raw: string;
  name: string;
  description: string;
  path: string;
};

function createSkillReferenceRuntimeState(): SkillReferenceRuntimeState {
  return { skills: [], byName: new Map() };
}

function updateSkillReferenceRuntimeState(
  state: SkillReferenceRuntimeState,
  skills: readonly Skill[],
): void {
  const sortedSkills = [...skills].toSorted((left, right) => left.name.localeCompare(right.name));
  state.skills = sortedSkills;
  state.byName = new Map(sortedSkills.map((skill) => [skill.name, skill]));
}

function loadConfiguredSkills(cwd: string): Skill[] {
  return loadSkills({
    cwd,
    agentDir: getAgentDir(),
    skillPaths: discoverSkillPaths(),
    includeDefaults: true,
  }).skills;
}

function extractSkillReferenceToken(textBeforeCursor: string): string | undefined {
  const match = textBeforeCursor.match(/(?:^|[\s([{"'])\$([^\s$]*)$/);
  return match?.[1];
}

function completeSkillItems(state: SkillReferenceRuntimeState, query: string): AutocompleteItem[] {
  return fuzzyFilter(state.skills, query, (skill) => `${skill.name} ${skill.description}`)
    .slice(0, MAX_AUTOCOMPLETE_ITEMS)
    .map((skill) => ({
      value: `$${skill.name}`,
      label: `$${skill.name}`,
      description: skill.description,
    }));
}

export function resolveSkillReferenceMentions(
  input: string,
  state: SkillReferenceRuntimeState,
): SkillReferenceMention[] {
  const mentions: SkillReferenceMention[] = [];
  const seen = new Set<string>();

  for (const match of input.matchAll(SKILL_MENTION_REGEX)) {
    const raw = match[2];
    const name = match[3];
    if (raw === undefined || name === undefined || seen.has(name)) {
      continue;
    }
    seen.add(name);

    const skill = state.byName.get(name);
    if (skill === undefined) {
      continue;
    }

    mentions.push({
      raw,
      name,
      description: skill.description,
      path: skill.filePath,
    });
  }

  return mentions;
}

export function buildSkillReferenceExpansionContent(mentions: SkillReferenceMention[]): string {
  if (mentions.length === 0) {
    return "";
  }

  return [
    "The user mentioned these skills. Please use each relevant skill by reading its SKILL.md path before acting:",
    ...mentions.map((mention) => `- ${mention.name}\n  path: ${mention.path}`),
  ].join("\n");
}

export function createSkillReferenceAutocompleteProvider(
  current: AutocompleteProvider,
  state: SkillReferenceRuntimeState,
): AutocompleteProvider {
  return {
    triggerCharacters: ["$", ...(current.triggerCharacters ?? [])],

    getSuggestions(lines, cursorLine, cursorCol, options) {
      const line = lines[cursorLine] ?? "";
      const token = extractSkillReferenceToken(line.slice(0, cursorCol));
      if (token === undefined) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      const items = completeSkillItems(state, token);
      if (items.length === 0) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      return Promise.resolve({
        prefix: `$${token}`,
        items,
      });
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

export function registerSkillReferenceAutocomplete(pi: ExtensionAPI): void {
  const state = createSkillReferenceRuntimeState();
  let autocompleteRegistered = false;

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    updateSkillReferenceRuntimeState(state, loadConfiguredSkills(ctx.cwd));

    if (
      autocompleteRegistered ||
      !ctx.hasUI ||
      typeof ctx.ui.addAutocompleteProvider !== "function"
    ) {
      return;
    }
    autocompleteRegistered = true;

    ctx.ui.addAutocompleteProvider((current) =>
      createSkillReferenceAutocompleteProvider(current, state),
    );
  });

  pi.on("before_agent_start", (event) => {
    if (event.systemPromptOptions.skills !== undefined) {
      updateSkillReferenceRuntimeState(state, event.systemPromptOptions.skills);
    }

    const mentions = resolveSkillReferenceMentions(event.prompt, state);
    const content = buildSkillReferenceExpansionContent(mentions);
    if (content.length === 0) {
      return {};
    }

    return {
      message: {
        customType: SKILL_REFERENCE_EXPANSION_MESSAGE,
        content,
        display: false,
        details: { mentions },
      },
    };
  });
}

export const __skillReferenceAutocompleteTest = {
  createSkillReferenceRuntimeState,
  updateSkillReferenceRuntimeState,
  extractSkillReferenceToken,
  completeSkillItems,
};
