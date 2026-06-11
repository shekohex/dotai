import type {
  ExecOptions,
  ExecResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import {
  __githubReferenceAutocompleteTest,
  createGitHubReferenceAutocompleteProvider,
} from "../src/extensions/coreui/github-reference-autocomplete.js";

type ExecCall = { command: string; args: string[]; options?: ExecOptions };

const theme = {
  fg: (_color: string, text: string) => text,
} as ExtensionContext["ui"]["theme"];

function result(stdout: string, code = 0, stderr = ""): ExecResult {
  return { stdout, stderr, code, killed: false };
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

function createExec(handler: (call: ExecCall) => ExecResult): {
  exec: ExtensionAPI["exec"];
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  return {
    calls,
    exec: vi.fn(async (command, args, options) => {
      const call = { command, args, options };
      calls.push(call);
      return handler(call);
    }),
  };
}

describe("coreui github reference autocomplete", () => {
  test("searches current repo issues and PRs for #query", async () => {
    vi.useFakeTimers();
    const { exec, calls } = createExec(({ args }) => {
      if (args[0] === "remote") {
        return result("origin\thttps://github.com/owner/repo.git (fetch)\n");
      }
      const state = args[args.indexOf("--state") + 1];
      if (args[1] === "issues" && state === "open") {
        return result(
          JSON.stringify([
            {
              number: 7,
              title: "Fix autocomplete issue",
              state: "open",
              url: "u",
              updatedAt: "2026-01-01T00:00:00Z",
            },
          ]),
        );
      }
      if (args[1] === "issues") {
        return result(
          JSON.stringify([
            {
              number: 8,
              title: "Closed autocomplete issue",
              state: "closed",
              url: "u",
              updatedAt: "2026-01-03T00:00:00Z",
            },
          ]),
        );
      }
      if (state === "closed") {
        return result(
          JSON.stringify([
            {
              number: 10,
              title: "Closed autocomplete PR",
              state: "closed",
              url: "u",
              updatedAt: "2026-01-04T00:00:00Z",
              isDraft: false,
            },
          ]),
        );
      }
      return result(
        JSON.stringify([
          {
            number: 9,
            title: "Autocomplete PR",
            state: "open",
            url: "u",
            updatedAt: "2026-01-02T00:00:00Z",
            isDraft: false,
          },
        ]),
      );
    });

    const provider = createGitHubReferenceAutocompleteProvider({
      current: createCurrentProvider(),
      exec,
      cwd: "/repo",
      theme,
    });
    const suggestionsPromise = provider.getSuggestions(["fix #auto"], 0, "fix #auto".length, {
      signal: new AbortController().signal,
    });
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(250);
    const suggestions = await suggestionsPromise;
    vi.useRealTimers();

    expect(suggestions?.prefix).toBe("#auto");
    expect(suggestions?.items.map((item) => item.value)).toEqual(["#9", "#7", "#10", "#8"]);
    expect(suggestions?.items[0]?.label).toBe("Autocomplete PR");
    expect(suggestions?.items[0]?.description).toContain("#9 PR open");
    expect(suggestions?.items[2]?.label).toBe("Closed autocomplete PR");
    expect(suggestions?.items[2]?.description).toContain("#10 PR closed");
    expect(calls.map((call) => call.args.slice(0, 4))).toEqual([
      ["remote", "-v"],
      ["search", "issues", "auto", "--repo"],
      ["search", "issues", "auto", "--repo"],
      ["search", "prs", "auto", "--repo"],
      ["search", "prs", "auto", "--repo"],
    ]);
    expect(calls.slice(1).map((call) => call.args[call.args.indexOf("--state") + 1])).toEqual([
      "open",
      "closed",
      "open",
      "closed",
    ]);
  });

  test("debounces gh search and aborts stale requests", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { exec, calls } = createExec(({ args }) => {
      if (args[0] === "remote") {
        return result("origin\tgit@github.com:owner/repo.git (fetch)\n");
      }
      return result("[]");
    });
    const provider = createGitHubReferenceAutocompleteProvider({
      current: createCurrentProvider(),
      exec,
      cwd: "/repo",
      theme,
    });

    const suggestionsPromise = provider.getSuggestions(["#old"], 0, "#old".length, {
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    await vi.advanceTimersByTimeAsync(250);
    const suggestions = await suggestionsPromise;
    vi.useRealTimers();

    expect(suggestions?.items[0]?.value).toBe("fallback");
    expect(calls.map((call) => call.args[0])).toEqual(["remote"]);
  });

  test("applies selection by replacing typed reference token", () => {
    const provider = createGitHubReferenceAutocompleteProvider({
      current: createCurrentProvider(),
      exec: vi.fn(),
      cwd: "/repo",
      theme,
    });

    const result = provider.applyCompletion(
      ["please check #autocom later"],
      0,
      "please check #autocom".length,
      {
        value: "#123",
        label: "#123",
      },
      "#autocom",
    );

    expect(result.lines).toEqual(["please check #123 later"]);
    expect(result.cursorCol).toBe("please check #123".length);
  });

  test("falls back and warns once when gh is unavailable or unauthenticated", async () => {
    const notify = vi.fn();
    const { exec } = createExec(({ args }) => {
      if (args[0] === "remote") {
        return result("", 1, "fatal: not a git repository");
      }
      if (args[0] === "repo") {
        return result("", 1, "gh: command not found");
      }
      return result("[]");
    });
    const provider = createGitHubReferenceAutocompleteProvider({
      current: createCurrentProvider(),
      exec,
      cwd: "/repo",
      theme,
      notify,
    });

    const first = await provider.getSuggestions(["#foo"], 0, "#foo".length, {
      signal: new AbortController().signal,
    });
    const second = await provider.getSuggestions(["#bar"], 0, "#bar".length, {
      signal: new AbortController().signal,
    });

    expect(first?.items[0]?.value).toBe("fallback");
    expect(second?.items[0]?.value).toBe("fallback");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      "GitHub autocomplete disabled: gh: command not found",
      "warning",
    );
  });

  test("ignores invalid gh JSON", () => {
    expect(__githubReferenceAutocompleteTest.parseJsonReferences("not-json")).toEqual([]);
    expect(
      __githubReferenceAutocompleteTest.parseJsonReferences(JSON.stringify([{ number: "bad" }])),
    ).toEqual([]);
  });

  test("parses GitHub repo from remote URLs", () => {
    expect(
      __githubReferenceAutocompleteTest.parseGitHubRepoFromRemote(
        "https://github.com/tangle-network/agent-dev-container.git",
      ),
    ).toBe("tangle-network/agent-dev-container");
    expect(
      __githubReferenceAutocompleteTest.parseGitHubRepoFromRemote(
        "git@github.com:tangle-network/agent-dev-container.git",
      ),
    ).toBe("tangle-network/agent-dev-container");
    expect(
      __githubReferenceAutocompleteTest.parseGitHubRepoFromRemote("git@gitlab.com:owner/repo.git"),
    ).toBeUndefined();
  });
});
