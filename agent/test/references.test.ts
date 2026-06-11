import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildReferencesSystemContext,
  createReferenceRuntimeState,
  createReferencesAutocompleteProvider,
  reloadReferenceConfig,
  refreshLoadedReferences,
  refreshReferences,
  rewriteReferenceMentions,
} from "../src/extensions/references/index.js";
import referencesExtension from "../src/extensions/references/index.js";
import {
  ReferencesDashboard,
  formatReferenceErrorForDisplay,
  formatReferenceRefreshAge,
} from "../src/extensions/references/dashboard.js";
import {
  ensureRepositoryCheckout,
  getRepositoryCachePath,
  parseRepositoryReference,
} from "../src/extensions/references/repository.js";
import { createTempDirSync } from "./test-utils/temp-paths.js";

function ok(stdout = ""): ExecResult {
  return { stdout, stderr: "", code: 0, killed: false };
}

function missing(): ExecResult {
  return { stdout: "", stderr: "missing", code: 1, killed: false };
}

function createCurrentProvider(): AutocompleteProvider {
  return {
    async getSuggestions() {
      return { prefix: "fallback", items: [{ value: "fallback", label: "fallback" }] };
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

describe("references extension", () => {
  afterEach(() => {
    delete process.env.PI_CODING_AGENT_DIR;
  });

  test("loads global and project references, project overrides aliases", async () => {
    const agentDir = createTempDirSync("agent-references-agent-");
    const projectDir = createTempDirSync("agent-references-project-");
    const globalDocs = join(agentDir, "global-docs");
    const projectDocs = join(projectDir, ".pi", "project-docs");
    await mkdir(globalDocs, { recursive: true });
    await mkdir(projectDocs, { recursive: true });
    await mkdir(join(projectDir, ".pi"), { recursive: true });
    await writeFile(
      join(agentDir, "references.json"),
      JSON.stringify({ docs: { path: "global-docs", description: "global docs" } }),
    );
    await writeFile(
      join(projectDir, ".pi", "references.json"),
      JSON.stringify({ docs: { path: "project-docs", description: "project docs" } }),
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const state = createReferenceRuntimeState();
    await refreshReferences({ exec: vi.fn(async () => ok()) }, projectDir, state);

    expect(state.references).toHaveLength(1);
    expect(state.references[0]).toMatchObject({
      alias: "docs",
      resolvedPath: projectDocs,
      description: "project docs",
      available: true,
    });
  });

  test("treats relative string shorthand as local path", async () => {
    const agentDir = createTempDirSync("agent-references-agent-");
    const projectDir = createTempDirSync("agent-references-project-");
    const docs = join(projectDir, "docs");
    await mkdir(join(projectDir, ".pi"), { recursive: true });
    await mkdir(docs, { recursive: true });
    await writeFile(
      join(projectDir, ".pi", "references.json"),
      JSON.stringify({ docs: "../docs" }),
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const exec = vi.fn(async () => ok());

    const state = createReferenceRuntimeState();
    await refreshReferences({ exec }, projectDir, state);

    expect(state.byAlias.get("docs")?.resolvedPath).toBe(docs);
    expect(exec).not.toHaveBeenCalled();
  });

  test("uses librarian cache path for git repositories", () => {
    const parsed = parseRepositoryReference("anomalyco/opencode");
    expect(parsed).not.toBeNull();
    expect(getRepositoryCachePath(parsed!)).toBe(
      join(process.env.HOME ?? "", ".cache", "checkouts", "github.com", "anomalyco", "opencode"),
    );
  });

  test("refreshes existing git checkouts by resetting to upstream", async () => {
    const exec = vi.fn(async (_command: string, args: string[]) => {
      const command = args.join(" ");
      if (command.includes("rev-parse --git-dir")) {
        return ok(".git\n");
      }
      if (command.includes("config remote.origin.promisor true")) {
        return ok();
      }
      if (command.includes("config remote.origin.partialclonefilter blob:none")) {
        return ok();
      }
      if (
        command.includes(
          "fetch --depth=1 --filter=blob:none --prune --force --no-tags origin +refs/heads/dev:refs/remotes/origin/dev",
        )
      ) {
        return ok();
      }
      if (command.includes("status --porcelain")) {
        return ok();
      }
      if (command.includes("@{upstream}")) {
        return ok("origin/dev\n");
      }
      if (command.includes("checkout -B dev origin/dev")) {
        return ok();
      }
      if (command.includes("reflog expire --expire=now --expire-unreachable=now --all")) {
        return ok();
      }
      if (command.includes("gc --prune=now")) {
        return ok();
      }
      throw new Error(`unexpected git command: ${command}`);
    });

    const result = await ensureRepositoryCheckout({ exec }, "anomalyco/opencode");

    expect(result.ok).toBe(true);
    expect(
      exec.mock.calls
        .map((call) => call[1].join(" "))
        .some((call) => call.includes("pull --ff-only")),
    ).toBe(false);
    expect(exec).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["checkout", "-B", "dev", "origin/dev"]),
      expect.objectContaining({ timeout: 30_000 }),
    );
    expect(exec).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["fetch", "--depth=1", "--filter=blob:none", "--no-tags"]),
      expect.objectContaining({ timeout: 60_000 }),
    );
    expect(exec).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["gc", "--prune=now"]),
      expect.objectContaining({ timeout: 60_000 }),
    );
  });

  test("formats reference refresh age for dashboard", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(formatReferenceRefreshAge(undefined, now)).toBe("never");
    expect(formatReferenceRefreshAge(now - 10_000, now)).toBe("just now");
    expect(formatReferenceRefreshAge(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatReferenceRefreshAge(now - 2 * 60 * 60_000, now)).toBe("2h ago");
    expect(formatReferenceRefreshAge(now - 3 * 24 * 60 * 60_000, now)).toBe("3d ago");
  });

  test("formats multiline git errors as one dashboard line", () => {
    expect(
      formatReferenceErrorForDisplay(
        [
          "hint: Diverging branches can't be fast-forwarded, you need to either:",
          "hint:",
          "fatal: Not possible to fast-forward, aborting.",
        ].join("\n"),
      ),
    ).toBe("fatal: Not possible to fast-forward, aborting.");
  });

  test("dashboard row navigation avoids forced full redraws", () => {
    const state = createReferenceRuntimeState();
    state.references = [
      {
        alias: "docs",
        sourceFile: "/project/.pi/references.json",
        sourceDir: "/project/.pi",
        path: "docs",
        hidden: false,
        kind: "local",
        resolvedPath: "/project/.pi/docs",
        available: true,
        refreshing: false,
      },
      {
        alias: "sdk",
        sourceFile: "/project/.pi/references.json",
        sourceDir: "/project/.pi",
        repository: "owner/repo",
        hidden: false,
        kind: "git",
        resolvedPath: "/home/user/.cache/checkouts/github.com/owner/repo",
        available: true,
        refreshing: false,
      },
    ];
    state.byAlias = new Map(state.references.map((reference) => [reference.alias, reference]));
    const requestRender = vi.fn();
    const refresh = vi.fn();
    const refreshAll = vi.fn();
    const dashboard = new ReferencesDashboard(
      { requestRender } as never,
      {} as never,
      state,
      {
        refresh,
        refreshAll,
        onError: vi.fn(),
      },
      vi.fn(),
    );

    dashboard.handleInput("j");
    dashboard.handleInput("k");
    dashboard.handleInput("\u001B[B");
    dashboard.handleInput("\u001B[A");
    dashboard.dispose();

    expect(requestRender).toHaveBeenCalledTimes(4);
    expect(requestRender).not.toHaveBeenCalledWith(true);
    expect(refresh).not.toHaveBeenCalled();
    expect(refreshAll).not.toHaveBeenCalled();
  });

  test("refresh all keeps other references updated when one refresh throws", async () => {
    const root = createTempDirSync("agent-references-durable-");
    const docs = join(root, "docs");
    await mkdir(docs, { recursive: true });
    const state = createReferenceRuntimeState();
    state.references = [
      {
        alias: "docs",
        sourceFile: join(root, "references.json"),
        sourceDir: root,
        path: "docs",
        hidden: false,
        kind: "local",
        resolvedPath: docs,
        available: false,
        refreshing: false,
      },
      {
        alias: "private",
        sourceFile: join(root, "references.json"),
        sourceDir: root,
        repository: "owner/private",
        hidden: false,
        kind: "git",
        resolvedPath: join(root, "missing-cache"),
        available: false,
        refreshing: false,
      },
    ];
    state.byAlias = new Map(state.references.map((reference) => [reference.alias, reference]));
    const exec = vi.fn(async () => {
      throw new Error("Authentication failed");
    });

    await refreshLoadedReferences({ exec }, state);

    expect(state.byAlias.get("docs")).toMatchObject({
      available: true,
      refreshing: false,
      error: undefined,
    });
    expect(state.byAlias.get("private")).toMatchObject({
      available: false,
      refreshing: false,
      error: "Authentication failed",
      suggestion: expect.stringContaining("credentials"),
    });
  });

  test("clones missing git references into checkout cache", async () => {
    const agentDir = createTempDirSync("agent-references-agent-");
    const projectDir = createTempDirSync("agent-references-project-");
    await writeFile(
      join(agentDir, "references.json"),
      JSON.stringify({ sdk: { repository: "owner/repo", branch: "main", description: "sdk" } }),
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes("rev-parse")) {
        return missing();
      }
      return ok();
    });

    const state = createReferenceRuntimeState();
    await refreshReferences({ exec }, projectDir, state);

    expect(exec).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining([
        "clone",
        "--filter=blob:none",
        "--depth=1",
        "--single-branch",
        "--no-tags",
        "--branch",
        "main",
      ]),
      expect.objectContaining({ timeout: 120_000 }),
    );
    expect(exec).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["gc", "--prune=now"]),
      expect.objectContaining({ timeout: 60_000 }),
    );
    expect(state.byAlias.get("sdk")?.resolvedPath).toContain(
      join(".cache", "checkouts", "github.com", "owner", "repo"),
    );
  });

  test("adds described references to system prompt and rewrites mentions", async () => {
    const root = createTempDirSync("agent-references-root-");
    const docs = join(root, "docs");
    await mkdir(docs, { recursive: true });
    const state = createReferenceRuntimeState();
    state.references = [
      {
        alias: "docs",
        sourceFile: join(root, "references.json"),
        sourceDir: root,
        path: "docs",
        description: "Use for docs",
        hidden: false,
        resolvedPath: docs,
        available: true,
      },
    ];
    state.byAlias = new Map(state.references.map((reference) => [reference.alias, reference]));

    expect(buildReferencesSystemContext(state)).toBe(
      [
        "Project references provide additional directories that can be accessed when relevant.",
        "<available_references>",
        "  <reference>",
        "    <name>docs</name>",
        `    <path>${docs}</path>`,
        "    <description>Use for docs</description>",
        "  </reference>",
        "</available_references>",
      ].join("\n"),
    );
    expect(rewriteReferenceMentions("compare @docs/README.md now", state)).toBe(
      `compare @docs/README.md (${join(docs, "README.md")}) now`,
    );
  });

  test("completes aliases and files while preserving fallback", async () => {
    const root = createTempDirSync("agent-references-complete-");
    const docs = join(root, "docs");
    await mkdir(join(docs, "src"), { recursive: true });
    await writeFile(join(docs, "src", "client.ts"), "export {};", "utf8");
    const state = createReferenceRuntimeState();
    state.references = [
      {
        alias: "sdk",
        sourceFile: join(root, "references.json"),
        sourceDir: root,
        path: "docs",
        description: "SDK implementation",
        hidden: false,
        resolvedPath: docs,
        available: true,
      },
    ];
    state.byAlias = new Map(state.references.map((reference) => [reference.alias, reference]));
    const provider = createReferencesAutocompleteProvider(createCurrentProvider(), state);

    const aliases = await provider.getSuggestions(["read @s"], 0, "read @s".length, {
      signal: new AbortController().signal,
    });
    expect(aliases?.items[0]?.value).toBe("@sdk");

    const files = await provider.getSuggestions(
      ["read @sdk/client"],
      0,
      "read @sdk/client".length,
      {
        signal: new AbortController().signal,
      },
    );
    expect(files?.items[0]?.value).toBe("@sdk/src/client.ts");
    expect(files?.items[0]?.description).toBe(join(docs, "src", "client.ts"));

    const fallback = await provider.getSuggestions(["read nothing"], 0, "read nothing".length, {
      signal: new AbortController().signal,
    });
    expect(fallback?.items[0]?.value).toBe("fallback");
  });

  test("registers session autocomplete, message renderer, and prompt context", async () => {
    const agentDir = createTempDirSync("agent-references-agent-");
    const projectDir = createTempDirSync("agent-references-project-");
    const docs = join(projectDir, "docs");
    await mkdir(docs, { recursive: true });
    await writeFile(
      join(agentDir, "references.json"),
      JSON.stringify({ docs: { path: docs, description: "Docs" } }),
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
    const pi = {
      exec: vi.fn(async () => ok()),
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      on(event: string, handler: (...args: any[]) => unknown) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
    };
    referencesExtension(pi as never);
    const autocompleteProviders: unknown[] = [];
    const ctx = {
      cwd: projectDir,
      ui: { addAutocompleteProvider: (provider: unknown) => autocompleteProviders.push(provider) },
    };

    await handlers.get("session_start")?.[0]?.({}, ctx);
    expect(autocompleteProviders).toHaveLength(1);
    expect(pi.registerMessageRenderer).toHaveBeenCalledWith(
      "reference-expansion",
      expect.any(Function),
    );

    expect(handlers.has("input")).toBe(false);

    const promptResult = handlers.get("before_agent_start")?.[0]?.({
      systemPrompt: "Base",
      prompt: "read @docs/a.md",
    });
    expect(promptResult).toMatchObject({
      systemPrompt: expect.stringContaining("<available_references>"),
      message: {
        customType: "reference-expansion",
        content: expect.stringContaining(`@docs/a.md -> ${join(docs, "a.md")}`),
        display: false,
      },
    });
  });

  test("session reload loads config but does not refresh git repositories", async () => {
    const agentDir = createTempDirSync("agent-references-agent-");
    const projectDir = createTempDirSync("agent-references-project-");
    await writeFile(
      join(agentDir, "references.json"),
      JSON.stringify({ sdk: { repository: "owner/repo", description: "SDK" } }),
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
    const exec = vi.fn(async () => ok());
    const pi = {
      exec,
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      on(event: string, handler: (...args: any[]) => unknown) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
    };
    referencesExtension(pi as never);
    const ctx = {
      cwd: projectDir,
      ui: { addAutocompleteProvider: vi.fn() },
    };

    await handlers.get("session_start")?.[0]?.({ reason: "reload" }, ctx);

    expect(exec).not.toHaveBeenCalled();
  });

  test("reloadReferenceConfig resolves git cache path without materializing repository", async () => {
    const agentDir = createTempDirSync("agent-references-agent-");
    const projectDir = createTempDirSync("agent-references-project-");
    await writeFile(
      join(agentDir, "references.json"),
      JSON.stringify({ sdk: { repository: "owner/repo", description: "SDK" } }),
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const state = createReferenceRuntimeState();
    await reloadReferenceConfig(projectDir, state);

    expect(state.byAlias.get("sdk")?.resolvedPath).toContain(
      join(".cache", "checkouts", "github.com", "owner", "repo"),
    );
    expect(state.byAlias.get("sdk")?.available).toBe(false);
  });
});
