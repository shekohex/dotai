import type { Skill } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import {
  __skillReferenceAutocompleteTest,
  buildSkillReferenceExpansionContent,
  createSkillReferenceAutocompleteProvider,
  resolveSkillReferenceMentions,
} from "../src/extensions/coreui/skill-reference-autocomplete.js";

function skill(name: string, description: string, filePath: string): Skill {
  return {
    name,
    description,
    filePath,
    baseDir: filePath.replace(/\/SKILL\.md$/, ""),
    disableModelInvocation: false,
    sourceInfo: { type: "file", path: filePath },
  } as Skill;
}

function createCurrentProvider(): AutocompleteProvider {
  return {
    async getSuggestions() {
      return {
        prefix: "fallback",
        items: [{ value: "fallback", label: "fallback" }],
      };
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const line = lines[cursorLine] ?? "";
      const beforePrefix = line.slice(0, cursorCol - prefix.length);
      const afterCursor = line.slice(cursorCol);
      const nextLines = [...lines];
      nextLines[cursorLine] = `${beforePrefix}${item.value}${afterCursor}`;
      return { lines: nextLines, cursorLine, cursorCol: beforePrefix.length + item.value.length };
    },
  };
}

describe("coreui skill reference autocomplete", () => {
  test("completes configured skills for $query", async () => {
    const state = __skillReferenceAutocompleteTest.createSkillReferenceRuntimeState();
    __skillReferenceAutocompleteTest.updateSkillReferenceRuntimeState(state, [
      skill("creating-issues", "Create GitHub issues", "/skills/creating-issues/SKILL.md"),
      skill("webfetch", "Fetch web pages as markdown", "/skills/webfetch/SKILL.md"),
    ]);
    const provider = createSkillReferenceAutocompleteProvider(createCurrentProvider(), state);

    const suggestions = await provider.getSuggestions(["please use $issue"], 0, 17, {
      signal: new AbortController().signal,
    });

    expect(suggestions?.prefix).toBe("$issue");
    expect(suggestions?.items.map((item) => item.value)).toEqual(["$creating-issues"]);
    expect(suggestions?.items[0]?.description).toBe("Create GitHub issues");
  });

  test("applies selection by replacing typed skill token", () => {
    const state = __skillReferenceAutocompleteTest.createSkillReferenceRuntimeState();
    const provider = createSkillReferenceAutocompleteProvider(createCurrentProvider(), state);

    const result = provider.applyCompletion(
      ["please use $iss later"],
      0,
      "please use $iss".length,
      { value: "$creating-issues", label: "$creating-issues" },
      "$iss",
    );

    expect(result.lines).toEqual(["please use $creating-issues later"]);
    expect(result.cursorCol).toBe("please use $creating-issues".length);
  });

  test("resolves mentioned skills into hidden expansion content", () => {
    const state = __skillReferenceAutocompleteTest.createSkillReferenceRuntimeState();
    __skillReferenceAutocompleteTest.updateSkillReferenceRuntimeState(state, [
      skill("webfetch", "Fetch web pages as markdown", "/skills/webfetch/SKILL.md"),
    ]);

    const mentions = resolveSkillReferenceMentions("Use $webfetch for this URL", state);
    const content = buildSkillReferenceExpansionContent(mentions);

    expect(mentions).toEqual([
      {
        raw: "$webfetch",
        name: "webfetch",
        description: "Fetch web pages as markdown",
        path: "/skills/webfetch/SKILL.md",
      },
    ]);
    expect(content).toContain("Please use each relevant skill");
    expect(content).toContain("- webfetch\n  path: /skills/webfetch/SKILL.md");
    expect(content).not.toContain("Fetch web pages as markdown\n  path:");
    expect(content).toContain("path: /skills/webfetch/SKILL.md");
  });

  test("falls back outside skill tokens", async () => {
    const state = __skillReferenceAutocompleteTest.createSkillReferenceRuntimeState();
    const provider = createSkillReferenceAutocompleteProvider(createCurrentProvider(), state);

    const suggestions = await provider.getSuggestions(["price is $5"], 0, "price is $5".length, {
      signal: new AbortController().signal,
    });

    expect(suggestions?.items[0]?.value).toBe("fallback");
  });
});
