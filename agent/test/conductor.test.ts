import { createHmac } from "node:crypto";
import { request } from "node:http";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";

import { parseConductorArgs } from "../src/conductor/commands/parser.js";
import { runConductorCommand } from "../src/conductor/command.js";
import { HerdrBackgroundShellBackend } from "../src/extensions/coreui/background-bash-herdr-backend.js";
import { HerdrAdapter } from "../src/subagent-sdk/herdr.js";
import {
  type GlobalConductorConfig,
  conductorConfigJsonSchema,
  findManagedRepositoryByPath,
  getConfigSchemaPath,
  initConfig,
  resolveRepositoryConfig,
  validateGlobalConfig,
  writeConductorConfigSchema,
  writeGlobalConfig,
} from "../src/conductor/config.js";
import { readConductorDaemonStatus, stopConductorDaemon } from "../src/conductor/daemon.js";
import {
  evaluateCondition,
  evaluateWrappedExpression,
  renderTemplate,
} from "../src/conductor/expression.js";
import {
  GhGitHubClient,
  parseGhIssueView,
  parseGhIssueComments,
  parseGhPrChecks,
  parseGhPrViewFeedback,
  parseGhPullRequestList,
  parseGhRepoView,
  parseGhReviewComments,
  parseGhUser,
  parseProjectItemsGraphql,
  type GitHubClient,
  type PullRequestFeedback,
  type PullRequestSummary,
} from "../src/conductor/github.js";
import {
  CliHerdrSessionManager,
  deliveryModeToSubmitKey,
  parseHerdrPanes,
  parseHerdrTabs,
  parseHerdrWorkspaces,
  type ConductorDeliveryMode,
  type HerdrRunInput,
  type HerdrSessionManager,
} from "../src/conductor/herdr.js";
import { ConductorOrchestrator } from "../src/conductor/orchestrator.js";
import { buildExpressionContext, validateInitialPromptTemplate } from "../src/conductor/prompt.js";
import {
  createRunId,
  createUuidV7,
  renderBranchTemplate,
  slugify,
} from "../src/conductor/run-id.js";
import { MemoryConductorStore } from "../src/conductor/store/memory.js";
import { SqliteConductorStore } from "../src/conductor/store/sqlite.js";
import type { HerdrHandles, RunRecord, WorkItem } from "../src/conductor/store/types.js";
import {
  SUPPORTED_WEBHOOK_EVENTS,
  processPendingWebhookDeliveries,
  readWebhookReconcileScope,
  resolveWebhookSecret,
  serveWebhook,
  verifyWebhookSignature,
} from "../src/conductor/webhook.js";
import { WorktreeManager, type WorktreeExec } from "../src/conductor/worktree.js";
import { DEFAULT_WORKFLOW_MARKDOWN, parseWorkflowFile } from "../src/conductor/workflow.js";
import { createTempDir } from "./test-utils/temp-paths.js";

describe("conductor config and workflow", () => {
  test("merges config with CLI > workflow > global precedence", () => {
    const globalRepo = managedRepo({
      dispatchLabel: "global",
      branchTemplate: "global/${{ github.issue.number }}",
      statusOptions: { in_progress: "Doing" },
    });

    const resolved = resolveRepositoryConfig(
      globalRepo,
      { dispatchLabel: "workflow", branchTemplate: "workflow/${{ github.issue.number }}" },
      { dispatchLabel: "cli" },
      "/state",
    );

    expect(resolved.dispatchLabel).toBe("cli");
    expect(resolved.branchTemplate).toBe("workflow/${{ github.issue.number }}");
    expect(resolved.statusOptions.in_progress).toBe("Doing");
    expect(resolved.statusOptions.done).toBe("Done");
  });

  test("validation reports TODO project placeholders", () => {
    const config = configWithRepo(
      managedRepo({ project: { owner: "TODO_PROJECT_OWNER", number: 0 } }),
    );
    expect(validateGlobalConfig(config)).toEqual([
      "octo/demo: project.owner is TODO",
      "octo/demo: project.number must be set",
    ]);
  });

  test("parses workflow frontmatter and prompt body", () => {
    const workflow = parseWorkflowFile(
      "/repo/.pi/WORKFLOW.md",
      [
        "---",
        "dispatchLabel: agent-ready",
        "worktreeHooks:",
        "  postCreate:",
        "    - npm install",
        "launchRules:",
        "  - if: \"${{ contains(github.issue.labels, 'deep') }}\"",
        '    flags: ["--mode-deep"]',
        "---",
        "Build ${{ github.issue.title }}",
      ].join("\n"),
    );

    expect(workflow.frontmatter.dispatchLabel).toBe("agent-ready");
    expect(workflow.frontmatter.launchRules?.[0]?.flags).toEqual(["--mode-deep"]);
    expect(workflow.frontmatter.worktreeHooks?.postCreate).toEqual(["npm install"]);
    expect(workflow.frontmatter.followUpRules).toBeUndefined();
    expect(workflow.promptTemplate).toBe("Build ${{ github.issue.title }}");
  });

  test("parses follow-up rules and conductor comment templates", () => {
    const workflow = parseWorkflowFile(
      "/repo/.pi/WORKFLOW.md",
      [
        "---",
        "followUpRules:",
        "  - name: review proof",
        "    if: \"${{ feedback.kind == 'review' }}\"",
        "    delivery: followUp",
        "    template: |",
        "      Review from ${{ github.review.author }}: ${{ feedback.body }}",
        "  - template: |",
        "      Always include PR ${{ github.pull_request.url }}",
        "conductorComments:",
        "  prAssociated:",
        '    template: "Tracking ${{ github.pull_request.url }}"',
        "  runBlocked:",
        "    enabled: false",
        "---",
        "Do it",
      ].join("\n"),
    );

    expect(workflow.frontmatter.followUpRules).toMatchObject([
      { name: "review proof", delivery: "followUp" },
      { template: "Always include PR ${{ github.pull_request.url }}\n" },
    ]);
    expect(workflow.frontmatter.conductorComments?.prAssociated).toMatchObject({
      template: "Tracking ${{ github.pull_request.url }}",
    });
    expect(workflow.frontmatter.conductorComments?.runBlocked).toMatchObject({ enabled: false });
  });

  test("strips workflow author comments from prompt body", () => {
    const workflow = parseWorkflowFile(
      "/repo/.pi/WORKFLOW.md",
      [
        "---",
        "dispatchLabel: ready-for-agent",
        "---",
        "Visible ${{ github.issue.title }}",
        "<!-- hidden example ${{ github.issue.missing }} -->",
        "Still visible.",
      ].join("\n"),
    );

    expect(workflow.promptTemplate).toBe("Visible ${{ github.issue.title }}\n\nStill visible.");
  });

  test("default workflow shows feature syntax without sending author notes", () => {
    const workflow = parseWorkflowFile("/repo/.pi/WORKFLOW.md", DEFAULT_WORKFLOW_MARKDOWN);
    expect(workflow.frontmatter.launchRules?.map((rule) => rule.flags)).toEqual([
      ["--mode-deep"],
      ["--mode-painter"],
      ["--mode-build"],
    ]);
    expect(DEFAULT_WORKFLOW_MARKDOWN).toContain("Conductor strips HTML comments");
    expect(workflow.promptTemplate).toContain("Role: autonomous implementation agent");
    expect(workflow.promptTemplate).not.toContain("Expression examples");
  });
});

describe("conductor expressions and names", () => {
  test("evaluates safe expression subset", () => {
    const context = { github: { issue: { number: 7, labels: ["ready", "deep"] } } };
    expect(
      evaluateCondition(
        "${{ contains(github.issue.labels, 'ready') && github.issue.number == 7 }}",
        context,
      ),
    ).toBe(true);
    expect(renderTemplate("Issue ${{ github.issue.number }}", context)).toBe("Issue 7");
    expect(() => renderTemplate("${{ github.issue.missing }}", context)).toThrow(
      "Missing expression value",
    );
  });

  test("evaluates GitHub-style expression helpers", async () => {
    const tempDir = await createTempDir("conductor-expression-");
    await mkdir(join(tempDir, "src"), { recursive: true });
    await writeFile(join(tempDir, "src", "a.ts"), "export const a = 1;\n");
    await writeFile(join(tempDir, "README.md"), "demo\n");
    const previousCi = process.env.CI;
    const previousVar = process.env.PI_CONDUCTOR_VAR_CHANNEL;
    const previousSecret = process.env.PI_CONDUCTOR_SECRET_TOKEN;
    process.env.CI = "true";
    process.env.PI_CONDUCTOR_VAR_CHANNEL = "nightly";
    process.env.PI_CONDUCTOR_SECRET_TOKEN = "secret-token";
    try {
      const context = buildExpressionContext({
        config: resolveRepositoryConfig(managedRepo({ repoPath: tempDir }), {}, {}, tempDir),
        workflow: parseWorkflowFile("WORKFLOW.md", "Do it"),
        workItem: workItem({
          labels: ["Ready", "UI"],
          projectFields: { Status: "Todo", "T-Shirt Size": "XL", Risk: 8 },
        }),
        plan: {
          owner: "octo",
          repo: "demo",
          issueNumber: 7,
          slug: "fix-bug",
          branch: "pi/7-fix-bug",
          baseRef: "main",
          worktreePath: join(tempDir, "worktree"),
        },
        runId: "run-1",
        attempt: 1,
      });

      expect(evaluateCondition("contains(github.issue.labels, 'ui')", context)).toBe(true);
      expect(
        evaluateCondition(
          "github.project.fields['T-Shirt Size'] == 'xl' && github.project.fields.Risk >= 8",
          context,
        ),
      ).toBe(true);
      expect(
        renderTemplate(
          "${{ github.issue.labels[0] }}|${{ join(github.issue.labels, ',') }}|${{ startsWith(github.issue.title, 'fix') }}|${{ endsWith(github.issue.title, 'BUG') }}",
          context,
        ),
      ).toBe("Ready|Ready,UI|true|true");
      expect(renderTemplate("${{ github.project.missing || 'fallback' }}", context)).toBe(
        "fallback",
      );
      expect(renderTemplate("${{ format('{0}/{1}', github.owner, github.repo) }}", context)).toBe(
        "octo/demo",
      );
      expect(
        renderTemplate("${{ env.CI }}:${{ vars.CHANNEL }}:${{ secrets.TOKEN }}", context),
      ).toBe("true:nightly:secret-token");
      expect(renderTemplate("${{ hashFiles('src/*.ts', '!src/ignore.ts') }}", context)).toMatch(
        /^[0-9a-f]{64}$/u,
      );
      expect(evaluateWrappedExpression("${{ fromJSON('[1,2]')[1] }}", context)).toBe(2);
      expect(evaluateWrappedExpression("${{ github.issue.labels.* }}", context)).toEqual([
        "Ready",
        "UI",
      ]);
      expect(
        evaluateCondition("success() && always() && !failure() && !cancelled()", context),
      ).toBe(true);
    } finally {
      restoreEnv("CI", previousCi);
      restoreEnv("PI_CONDUCTOR_VAR_CHANNEL", previousVar);
      restoreEnv("PI_CONDUCTOR_SECRET_TOKEN", previousSecret);
    }
  });

  test("renders branch template and run id", () => {
    expect(slugify("Fix API: retry!", 20)).toBe("fix-api-retry");
    expect(() =>
      renderBranchTemplate("{prefix}/{kind}-{issue}-{slug}-{owner}-{repo}", {
        prefix: "pi",
        kind: "bug",
        issue: 12,
        slug: "Fix API: retry!",
        owner: "Octo Org",
        repo: "Demo Repo",
      }),
    ).toThrow("Use ${{ ... }} expressions");
    expect(
      renderBranchTemplate(
        "${{ conductor.branchPrefix }}/${{ conductor.branchKind }}-${{ github.issue.number }}-${{ github.issue.slug }}-${{ github.owner }}-${{ github.repo }}",
        {
          prefix: "pi",
          kind: "bug",
          issue: 12,
          slug: "Fix API: retry!",
          owner: "Octo Org",
          repo: "Demo Repo",
        },
      ),
    ).toBe("pi/bug-12-fix-api-retry-octo-org-demo-repo");

    const uuid = createUuidV7(new Date("2026-07-05T00:00:00.000Z"));
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(createRunId({ owner: "Octo Org", repo: "Demo Repo", issueNumber: 12 })).toMatch(
      /^octo_org__demo_repo__12__[0-9a-f-]{36}$/u,
    );
    expect(() =>
      renderBranchTemplate("pi/{issue_id}-{slug}", {
        prefix: "pi",
        kind: "bug",
        issue: 12,
        slug: "fix",
        owner: "octo",
        repo: "demo",
      }),
    ).toThrow("Use ${{ ... }} expressions");
    expect(() =>
      renderBranchTemplate("pi/${{ issue }}-${{ slug }}", {
        prefix: "pi",
        kind: "bug",
        issue: 12,
        slug: "fix",
        owner: "octo",
        repo: "demo",
      }),
    ).toThrow("Missing expression value: issue");
  });

  test("exposes configured project field aliases", () => {
    const config = resolveRepositoryConfig(
      managedRepo({ effortField: "T-Shirt Size", priorityField: "Impact" }),
      {},
    );
    const context = buildExpressionContext({
      config,
      workflow: parseWorkflowFile("WORKFLOW.md", "Do it"),
      workItem: workItem({
        projectFields: { Status: "Todo", "T-Shirt Size": "L", Impact: "High" },
      }),
      plan: {
        owner: "octo",
        repo: "demo",
        issueNumber: 7,
        slug: "fix-bug",
        branch: "pi/7-fix-bug",
        baseRef: "main",
        worktreePath: "/tmp/worktree",
      },
      runId: "run-1",
      attempt: 1,
    });
    expect(
      renderTemplate("${{ github.project.effort }}:${{ github.project.priority }}", context),
    ).toBe("L:High");
  });

  test("project field aliases render empty when item field is absent", () => {
    const config = resolveRepositoryConfig(managedRepo(), {});
    const context = buildExpressionContext({
      config,
      workflow: parseWorkflowFile("WORKFLOW.md", "Do it"),
      workItem: workItem({ projectFields: { Status: "Todo" } }),
      plan: {
        owner: "octo",
        repo: "demo",
        issueNumber: 7,
        slug: "fix-bug",
        branch: "pi/7-fix-bug",
        baseRef: "main",
        worktreePath: "/tmp/worktree",
      },
      runId: "run-1",
      attempt: 1,
    });
    expect(renderTemplate("${{ github.project.priority }}", context)).toBe("");
    expect(renderTemplate("${{ github.project.priority || 'None' }}", context)).toBe("None");
  });

  test("validates workflow prompt and launch rule expressions", () => {
    const config = resolveRepositoryConfig(managedRepo(), {});
    expect(() =>
      validateInitialPromptTemplate({
        config,
        workflow: parseWorkflowFile(
          "WORKFLOW.md",
          [
            "---",
            "launchRules:",
            "  - if: github.project.priorit == 'High'",
            "    flags: []",
            "---",
            "Priority: ${{ github.project.priorit }}",
          ].join("\n"),
        ),
      }),
    ).toThrow("Missing expression value: github.project.priorit");
  });

  test("validates follow-up and conductor comment templates", () => {
    const config = resolveRepositoryConfig(managedRepo(), {});
    expect(() =>
      validateInitialPromptTemplate({
        config,
        workflow: parseWorkflowFile(
          "WORKFLOW.md",
          [
            "---",
            "followUpRules:",
            '  - template: "${{ feedback.missing }}"',
            "conductorComments:",
            "  prAssociated:",
            '    template: "${{ github.pull_request.missing }}"',
            "---",
            "Do it",
          ].join("\n"),
        ),
      }),
    ).toThrow("Missing expression value: feedback.missing");
  });
});

describe("conductor store and command parser", () => {
  test("memory store rejects duplicate active runs", async () => {
    const store = new MemoryConductorStore();
    const first = runRecord({ runId: "run-1" });
    await store.createRun(first);
    await expect(store.createRun(runRecord({ runId: "run-2" }))).rejects.toThrow(
      "Active run already exists",
    );
    await store.updateRun({ ...first, status: "blocked" });
    await expect(store.createRun(runRecord({ runId: "run-2" }))).resolves.toBeUndefined();
  });

  test("parses local command surface", () => {
    expect(parseConductorArgs([])).toEqual({ kind: "help" });
    expect(parseConductorArgs(["status", "--json"])).toEqual({ kind: "status", json: true });
    expect(parseConductorArgs(["run", "octo/demo#3", "--mode-deep"])).toEqual({
      kind: "run",
      reference: "octo/demo#3",
      launchFlags: ["--mode-deep"],
      configOverrides: {},
    });
    expect(
      parseConductorArgs(["run", "octo/demo#3", "--base-ref", "release", "--mode-deep"]),
    ).toEqual({
      kind: "run",
      reference: "octo/demo#3",
      launchFlags: ["--mode-deep"],
      configOverrides: { baseRef: "release" },
    });
    expect(parseConductorArgs(["send", "run-1", "fix", "tests", "--follow-up"])).toEqual({
      kind: "send",
      runId: "run-1",
      message: "fix tests",
      delivery: "followUp",
    });
    expect(parseConductorArgs(["cleanup", "--merged"])).toEqual({ kind: "cleanup-merged" });
    expect(parseConductorArgs(["cleanup", "--merged", "run-1"])).toEqual({
      kind: "cleanup",
      runId: "run-1",
      merged: true,
    });
    expect(
      parseConductorArgs(["cleanup", "--gc", "--older-than-days", "7", "--no-vacuum"]),
    ).toEqual({
      kind: "cleanup-gc",
      olderThanDays: 7,
      vacuum: false,
    });
    for (const action of ["start", "stop", "restart", "status"] as const) {
      expect(parseConductorArgs(["daemon", action])).toEqual({ kind: "daemon", action });
    }
    expect(() => parseConductorArgs(["daemon", "bogus"])).toThrow(
      "Usage: pi conductor daemon <start|stop|restart|status>",
    );
    expect(parseConductorArgs(["completion", "bash"])).toEqual({
      kind: "completion",
      shell: "bash",
    });
    expect(parseConductorArgs(["config", "format"])).toEqual({ kind: "config-format" });
    expect(parseConductorArgs(["config", "edit"])).toEqual({ kind: "config-edit" });
    expect(
      parseConductorArgs(["config", "get", "repositories[0].project.number", "--json"]),
    ).toEqual({
      kind: "config-get",
      path: "repositories[0].project.number",
      json: true,
    });
    expect(parseConductorArgs(["config", "set", "repositories[0].project.number", "12"])).toEqual({
      kind: "config-set",
      path: "repositories[0].project.number",
      value: "12",
    });
    expect(parseConductorArgs(["run", "--help"])).toEqual({ kind: "help", topic: "run" });
    expect(() => parseConductorArgs(["completion", "fish"])).toThrow(
      "Usage: pi conductor completion <bash|zsh>",
    );
    expect(parseConductorArgs(["send", "run-1", "use", "--", "--follow-up"])).toEqual({
      kind: "send",
      runId: "run-1",
      message: "use --follow-up",
      delivery: "steer",
    });
    expect(parseConductorArgs(["send", "run-1", "--follow-up", "fix", "tests"])).toEqual({
      kind: "send",
      runId: "run-1",
      message: "fix tests",
      delivery: "followUp",
    });
  });

  test("sqlite store persists runs and delivery state", async () => {
    const tempDir = await createTempDir("conductor-sqlite-");
    const dbPath = join(tempDir, "state.sqlite");
    const store = new SqliteConductorStore(dbPath);
    await store.init();
    try {
      const first = runRecord({ runId: "run-1" });
      await store.createRun(first);
      await expect(
        Promise.resolve().then(() => store.createRun(runRecord({ runId: "run-2" }))),
      ).rejects.toThrow();
      await store.updateRun({ ...first, status: "done" });
      await expect(store.createRun(runRecord({ runId: "run-2" }))).resolves.toBeUndefined();

      await expect(
        store.recordDelivery({
          deliveryId: "delivery-1",
          eventName: "issues",
          receivedAt: "2026-07-05T00:00:00.000Z",
          metadata: {},
        }),
      ).resolves.toBe(true);
      await expect(
        store.recordDelivery({
          deliveryId: "delivery-1",
          eventName: "issues",
          receivedAt: "2026-07-05T00:00:00.000Z",
          metadata: {},
        }),
      ).resolves.toBe(false);
      await store.markDeliveryStatus("delivery-1", "failed", { lastError: "boom" });
      await expect(store.getDelivery("delivery-1")).resolves.toMatchObject({
        status: "failed",
        lastError: "boom",
      });
      await expect(store.listDeliveriesByStatus("failed")).resolves.toHaveLength(1);
    } finally {
      store.close();
    }
    expect(readSqlitePragmaValue(dbPath, "journal_mode").toLowerCase()).toBe("wal");
  });

  test("writes conductor config JSON schema", async () => {
    const tempDir = await createTempDir("conductor-schema-");
    const configPath = join(tempDir, "config.json");

    const schemaPath = await writeConductorConfigSchema(configPath);

    expect(schemaPath).toBe(getConfigSchemaPath(configPath));
    const schema = JSON.parse(await readFile(schemaPath, "utf8")) as Record<string, unknown>;
    expect(schema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "Pi Conductor Config",
    });
    expect(conductorConfigJsonSchema()).toMatchObject({ title: "Pi Conductor Config" });
  });

  test("config get set and format support automation", async () => {
    const tempDir = await createTempDir("conductor-config-automation-");
    const configPath = join(tempDir, "conductor", "config.json");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = tempDir;
    await writeGlobalConfig(
      configWithRepo(managedRepo({ project: { owner: "octo", number: 1 } })),
      configPath,
    );
    try {
      const getNumber = writableCapture();
      await expect(
        runConductorCommand(["config", "get", "repositories[0].project.number", "--json"], {
          cwd: tempDir,
          stdout: getNumber,
        }),
      ).resolves.toBe(0);
      expect(getNumber.text()).toBe("1\n");

      await expect(
        runConductorCommand(["config", "set", "repositories[0].project.number", "12"], {
          cwd: tempDir,
          stdout: writableCapture(),
        }),
      ).resolves.toBe(0);

      const getUpdatedNumber = writableCapture();
      await expect(
        runConductorCommand(["config", "get", ".repositories[0].project.number"], {
          cwd: tempDir,
          stdout: getUpdatedNumber,
        }),
      ).resolves.toBe(0);
      expect(getUpdatedNumber.text()).toBe("12\n");

      const formatOutput = writableCapture();
      await expect(
        runConductorCommand(["config", "format"], { cwd: tempDir, stdout: formatOutput }),
      ).resolves.toBe(0);
      expect(formatOutput.text()).toContain("Formatted");
      const formatted = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
      expect(formatted.$schema).toBe("./config.schema.json");
      await expect(
        readFile(join(tempDir, "conductor", "config.schema.json"), "utf8"),
      ).resolves.toContain("Pi Conductor Config");
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });

  test("config init rerun preserves existing repository settings", async () => {
    const tempDir = await createTempDir("conductor-init-idempotent-");
    const repoPath = join(tempDir, "repo");
    const binPath = join(tempDir, "bin");
    const configPath = join(tempDir, "config.json");
    await mkdir(repoPath, { recursive: true });
    await mkdir(binPath, { recursive: true });
    await writeExecutable(
      join(binPath, "git"),
      ["#!/bin/sh", `echo ${shellEscape(repoPath)}`, ""].join("\n"),
    );
    await writeExecutable(
      join(binPath, "gh"),
      [
        "#!/bin/sh",
        `echo ${shellEscape(JSON.stringify({ nameWithOwner: "octo/demo", projectsV2: { nodes: [] } }))}`,
        "",
      ].join("\n"),
    );
    await writeGlobalConfig(
      configWithRepo(
        managedRepo({
          repoPath: "/old/path",
          project: { owner: "real-owner", number: 99 },
          dispatchLabel: "custom-ready",
          branchTemplate: "feature/${{ github.issue.number }}",
        }),
      ),
      configPath,
    );
    const previousPath = process.env.PATH;
    process.env.PATH = `${binPath}:${previousPath ?? ""}`;
    try {
      const result = await initConfig(repoPath, configPath);
      expect(result).toMatchObject({
        repositoryAdded: false,
        repositoryCount: 1,
        configMigrated: true,
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }

    const config = JSON.parse(await readFile(configPath, "utf8")) as GlobalConductorConfig;
    expect(config.$schema).toBe("./config.schema.json");
    expect(config.repositories[0]).toMatchObject({
      repoPath,
      project: { owner: "real-owner", number: 99 },
      dispatchLabel: "custom-ready",
      branchTemplate: "feature/${{ github.issue.number }}",
    });
  });

  test("logs command reports empty run log", async () => {
    const tempDir = await createTempDir("conductor-empty-logs-");
    const stdout = writableCapture();

    await expect(
      runConductorCommand(["logs", "missing-run"], { cwd: tempDir, stdout }),
    ).resolves.toBe(0);

    expect(stdout.text()).toBe("No logs for missing-run.\n");
  });

  test("config validate suggests init when config is missing", async () => {
    const tempDir = await createTempDir("conductor-missing-config-");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const stderr = writableCapture();
    process.env.PI_CODING_AGENT_DIR = tempDir;
    try {
      await expect(
        runConductorCommand(["config", "validate"], { cwd: tempDir, stderr }),
      ).resolves.toBe(1);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }

    expect(stderr.text()).toContain("Conductor config not found:");
    expect(stderr.text()).toContain("pi conductor config init");
    expect(stderr.text()).not.toContain("ENOENT");
  });

  test("completion command prints bash and zsh scripts", async () => {
    const bash = writableCapture();
    const zsh = writableCapture();

    await expect(
      runConductorCommand(["completion", "bash"], { cwd: "/tmp", stdout: bash }),
    ).resolves.toBe(0);
    await expect(
      runConductorCommand(["completion", "zsh"], { cwd: "/tmp", stdout: zsh }),
    ).resolves.toBe(0);

    expect(bash.text()).toContain("complete -F _pi_conductor_completion pi");
    expect(bash.text()).toContain("--branch-template");
    expect(zsh.text()).toContain("#compdef pi");
    expect(zsh.text()).toContain("daemon_actions");
  });

  test("help includes detailed option defaults", async () => {
    const stdout = writableCapture();

    await expect(runConductorCommand(["run", "--help"], { cwd: "/tmp", stdout })).resolves.toBe(0);

    expect(stdout.text()).toContain("Usage: pi conductor run");
    expect(stdout.text()).toContain("--branch-template TPL");
    expect(stdout.text()).toContain("pi/${{ github.issue.number }}-${{ github.issue.slug }}");
  });

  test("daemon status ignores stale pid file for unrelated process", async () => {
    const tempDir = await createTempDir("conductor-daemon-stale-");
    const daemonDir = join(tempDir, "daemon");
    await mkdir(daemonDir, { recursive: true });
    const pidPath = join(daemonDir, "conductor.pid");
    await writeFile(pidPath, `${process.pid}\n`, "utf8");

    await expect(readConductorDaemonStatus(tempDir)).resolves.toMatchObject({ running: false });
    await expect(stopConductorDaemon(tempDir)).resolves.toMatchObject({
      running: false,
      stopped: false,
    });
    await expect(readFile(pidPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("store GC prunes old terminal events and old completed deliveries", async () => {
    const tempDir = await createTempDir("conductor-sqlite-gc-");
    const store = new SqliteConductorStore(join(tempDir, "state.sqlite"));
    await store.init();
    try {
      await store.createRun(
        runRecord({
          runId: "done-run",
          status: "done",
          updatedAt: "2020-01-01T00:00:00.000Z",
        }),
      );
      await store.createRun(
        runRecord({
          runId: "active-run",
          issueNumber: 8,
          status: "in_progress",
          updatedAt: "2020-01-01T00:00:00.000Z",
        }),
      );
      await store.appendEvent({
        runId: "done-run",
        kind: "old_done_event",
        payload: {},
        createdAt: "2020-01-01T00:00:00.000Z",
      });
      await store.appendEvent({
        runId: "active-run",
        kind: "old_active_event",
        payload: {},
        createdAt: "2020-01-01T00:00:00.000Z",
      });
      await store.recordDelivery({
        deliveryId: "processed-old",
        eventName: "issues",
        receivedAt: "2020-01-01T00:00:00.000Z",
        status: "processed",
        metadata: {},
      });
      await store.recordDelivery({
        deliveryId: "received-old",
        eventName: "issues",
        receivedAt: "2020-01-01T00:00:00.000Z",
        status: "received",
        metadata: {},
      });

      await expect(store.gc({ olderThanDays: 1, vacuum: false })).resolves.toMatchObject({
        deletedEvents: 1,
        deletedDeliveries: 1,
        vacuumed: false,
        walCheckpointed: true,
      });
      await expect(store.listEvents("done-run")).resolves.toEqual([]);
      await expect(store.listEvents("active-run")).resolves.toMatchObject([
        { kind: "old_active_event" },
      ]);
      await expect(store.hasDelivery("processed-old")).resolves.toBe(false);
      await expect(store.hasDelivery("received-old")).resolves.toBe(true);
    } finally {
      store.close();
    }
  });

  test("matches managed repository paths on directory boundaries", () => {
    const config = configWithRepo(managedRepo({ repoPath: "/tmp/repo" }));
    expect(findManagedRepositoryByPath(config, "/tmp/repo/subdir")).toMatchObject({ repo: "demo" });
    expect(findManagedRepositoryByPath(config, "/tmp/repository")).toBeUndefined();
  });

  test("verifies webhook signatures", () => {
    const body = Buffer.from(JSON.stringify({ action: "opened" }));
    const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
    expect(verifyWebhookSignature("secret", body, signature)).toBe(true);
    expect(verifyWebhookSignature("secret", Buffer.from("{}"), signature)).toBe(false);
  });

  test("rejects empty webhook secret files", async () => {
    const tempDir = await createTempDir("conductor-webhook-secret-");
    const secretPath = join(tempDir, "secret.txt");
    await writeFile(secretPath, "\n");
    await expect(
      resolveWebhookSecret({
        host: "127.0.0.1",
        port: 3000,
        path: "/hook",
        secret: { file: secretPath },
      }),
    ).rejects.toThrow("Webhook secret file is empty");
  });

  test("resolves relative webhook secret files from config directory", async () => {
    const tempDir = await createTempDir("conductor-webhook-secret-relative-");
    const configDir = join(tempDir, "conductor");
    const secretPath = join(configDir, "secrets", "webhook.txt");
    await mkdir(dirname(secretPath), { recursive: true });
    await writeFile(secretPath, "file-secret\n");

    await expect(
      resolveWebhookSecret(
        {
          host: "127.0.0.1",
          port: 8787,
          path: "/github/webhook",
          secret: { file: "secrets/webhook.txt" },
        },
        join(configDir, "config.json"),
      ),
    ).resolves.toBe("file-secret");
  });

  test("extracts scoped reconcile data from pull request webhooks", () => {
    expect(
      readWebhookReconcileScope("pull_request", {
        repository: { full_name: "octo/demo" },
        pull_request: {
          number: 2,
          html_url: "https://github.com/octo/demo/pull/2",
          state: "closed",
          merged: true,
          merged_at: "2026-07-05T00:00:00Z",
          draft: false,
          head: { ref: "pi/7-fix-bug" },
        },
      }),
    ).toMatchObject({
      owner: "octo",
      repo: "demo",
      prNumber: 2,
      branch: "pi/7-fix-bug",
      pullRequest: { number: 2, state: "MERGED", mergedAt: "2026-07-05T00:00:00Z" },
    });
  });

  test("extracts scoped reconcile data from every supported webhook event", () => {
    const pullRequest = {
      number: 2,
      html_url: "https://github.com/octo/demo/pull/2",
      state: "open",
      merged: false,
      draft: false,
      head: { ref: "pi/7-fix-bug" },
    };
    const cases: Array<[string, unknown, Record<string, unknown>]> = [
      ["issues", { issue: { number: 7 } }, { issueNumber: 7 }],
      ["issue_comment", { issue: { number: 7 } }, { issueNumber: 7 }],
      [
        "issue_comment",
        { issue: { number: 2, pull_request: { url: "https://api.github.com/pr/2" } } },
        { prNumber: 2 },
      ],
      ["pull_request", { pull_request: pullRequest }, { prNumber: 2, branch: "pi/7-fix-bug" }],
      [
        "pull_request_review",
        { pull_request: pullRequest },
        { prNumber: 2, branch: "pi/7-fix-bug" },
      ],
      [
        "pull_request_review_comment",
        { pull_request: pullRequest },
        { prNumber: 2, branch: "pi/7-fix-bug" },
      ],
      [
        "check_run",
        { check_run: { pull_requests: [{ number: 2, head_branch: "pi/7-fix-bug" }] } },
        { prNumber: 2, branch: "pi/7-fix-bug" },
      ],
      [
        "check_suite",
        { check_suite: { pull_requests: [{ number: 2, head_branch: "pi/7-fix-bug" }] } },
        { prNumber: 2, branch: "pi/7-fix-bug" },
      ],
      ["status", { branches: [{ name: "pi/7-fix-bug" }] }, { branch: "pi/7-fix-bug" }],
      [
        "workflow_run",
        { workflow_run: { pull_requests: [{ number: 2, head_branch: "pi/7-fix-bug" }] } },
        { prNumber: 2, branch: "pi/7-fix-bug" },
      ],
      ["projects_v2_item", { projects_v2_item: { id: "PVTI_1" } }, { projectItemId: "PVTI_1" }],
    ];

    expect(new Set(cases.map(([eventName]) => eventName))).toEqual(
      new Set(SUPPORTED_WEBHOOK_EVENTS),
    );
    for (const [eventName, payload, expectedScope] of cases) {
      expect(
        readWebhookReconcileScope(eventName, {
          repository: { full_name: "octo/demo" },
          ...(payload as Record<string, unknown>),
        }),
      ).toMatchObject({ owner: "octo", repo: "demo", reason: eventName, ...expectedScope });
    }
  });

  test("webhook acknowledges after durable record without waiting for reconcile", async () => {
    const store = new MemoryConductorStore();
    await store.init();
    const reconcileStarted = deferred<void>();
    const finishReconcile = deferred<void>();
    const orchestrator = {
      async reconcile() {
        reconcileStarted.resolve();
        await finishReconcile.promise;
        return [];
      },
    } as unknown as ConductorOrchestrator;
    process.env.TEST_SECRET = "secret";
    const server = await serveWebhook({
      config: { host: "127.0.0.1", port: 0, path: "/hook", secret: { env: "TEST_SECRET" } },
      store,
      orchestrator,
      repositories: [{ owner: "octo", repo: "demo" }],
    });
    try {
      const response = await Promise.race([
        postWebhook(server.port, "/hook", "secret", "issues", "delivery-ack", {
          repository: { full_name: "octo/demo" },
          issue: { number: 7 },
        }),
        delay(250).then(() => undefined),
      ]);
      expect(response).toEqual({ statusCode: 202, body: "accepted" });
      await reconcileStarted.promise;
      await expect(store.getDelivery("delivery-ack")).resolves.toMatchObject({
        status: "processing",
      });
      finishReconcile.resolve();
      await processPendingWebhookDeliveries({ store, orchestrator });
      await expect(store.getDelivery("delivery-ack")).resolves.toMatchObject({
        status: "processed",
      });
    } finally {
      finishReconcile.resolve();
      await server.close();
      delete process.env.TEST_SECRET;
    }
  });

  test("failed webhook delivery uses retry backoff", async () => {
    const store = new MemoryConductorStore();
    await store.init();
    await store.recordDelivery({
      deliveryId: "delivery-rate-limit",
      eventName: "pull_request",
      receivedAt: new Date().toISOString(),
      status: "received",
      metadata: {},
    });
    const orchestrator = {
      async reconcile() {
        throw new Error("network unavailable");
      },
    } as unknown as ConductorOrchestrator;

    await processPendingWebhookDeliveries({ store, orchestrator });
    const failed = await store.getDelivery("delivery-rate-limit");
    expect(failed).toMatchObject({ status: "failed", attempts: 1 });
    expect(failed?.nextAttemptAt).toBeTruthy();
    await processPendingWebhookDeliveries({ store, orchestrator });
    await expect(store.getDelivery("delivery-rate-limit")).resolves.toMatchObject({ attempts: 1 });
  });

  test("processing webhook delivery stops after max crash-replay attempts", async () => {
    const store = new MemoryConductorStore();
    await store.init();
    await store.recordDelivery({
      deliveryId: "delivery-crash-loop",
      eventName: "issues",
      receivedAt: new Date().toISOString(),
      status: "processing",
      attempts: 3,
      metadata: {},
    });
    let reconcileCalls = 0;
    const orchestrator = {
      async reconcile() {
        reconcileCalls += 1;
        return [];
      },
    } as unknown as ConductorOrchestrator;

    await processPendingWebhookDeliveries({ store, orchestrator });

    expect(reconcileCalls).toBe(0);
    await expect(store.getDelivery("delivery-crash-loop")).resolves.toMatchObject({
      status: "failed",
      attempts: 3,
      lastError: "Webhook delivery exceeded max attempts while processing",
    });
  });

  test("webhook delivery loop stops on GitHub rate limit", async () => {
    const store = new MemoryConductorStore();
    await store.init();
    for (const deliveryId of ["delivery-rate-limit-1", "delivery-rate-limit-2"]) {
      await store.recordDelivery({
        deliveryId,
        eventName: "issues",
        receivedAt: new Date().toISOString(),
        status: "received",
        metadata: {},
      });
    }
    let reconcileCalls = 0;
    const orchestrator = {
      async reconcile() {
        reconcileCalls += 1;
        throw new Error("GitHub secondary rate limit");
      },
    } as unknown as ConductorOrchestrator;

    await expect(processPendingWebhookDeliveries({ store, orchestrator })).rejects.toThrow(
      "GitHub secondary rate limit",
    );

    expect(reconcileCalls).toBe(1);
    await expect(store.getDelivery("delivery-rate-limit-1")).resolves.toMatchObject({
      status: "failed",
      attempts: 1,
    });
    await expect(store.getDelivery("delivery-rate-limit-2")).resolves.toMatchObject({
      status: "received",
    });
  });
});

describe("conductor adapters", () => {
  test("parses Herdr JSON and maps send delivery", () => {
    expect(
      parseHerdrWorkspaces(
        JSON.stringify({ result: { workspaces: [{ workspace_id: "w1", label: "octo/demo" }] } }),
      ),
    ).toEqual([{ workspaceId: "w1", label: "octo/demo" }]);
    expect(
      parseHerdrTabs(JSON.stringify({ result: { tabs: [{ tab_id: "w1:t1", label: "#7 fix" }] } })),
    ).toEqual([{ tabId: "w1:t1", label: "#7 fix" }]);
    expect(
      parseHerdrPanes(
        JSON.stringify({ result: { panes: [{ pane_id: "w1:p1", tab_id: "w1:t1" }] } }),
      ),
    ).toEqual([{ paneId: "w1:p1", tabId: "w1:t1" }]);
    expect(deliveryModeToSubmitKey("steer")).toBe("enter");
    expect(deliveryModeToSubmitKey("followUp")).toBe("alt+enter");
  });

  test("Herdr launch recreates an existing tab with no pane", async () => {
    const calls: string[][] = [];
    const herdr = new CliHerdrSessionManager(async (_file, args) => {
      calls.push(args);
      if (args[0] === "workspace" && args[1] === "list") {
        return {
          stdout: JSON.stringify({
            result: { workspaces: [{ workspace_id: "w1", label: "octo/demo" }] },
          }),
          stderr: "",
        };
      }
      if (args[0] === "tab" && args[1] === "list") {
        return {
          stdout: JSON.stringify({ result: { tabs: [{ tab_id: "t1", label: "#7 fix-bug" }] } }),
          stderr: "",
        };
      }
      if (args[0] === "pane" && args[1] === "list") {
        return { stdout: JSON.stringify({ result: { panes: [] } }), stderr: "" };
      }
      if (args[0] === "tab" && args[1] === "create") {
        return {
          stdout: JSON.stringify({ result: { tab_id: "t2", root_pane: { pane_id: "p2" } } }),
          stderr: "",
        };
      }
      return { stdout: JSON.stringify({ result: {} }), stderr: "" };
    });

    await expect(
      herdr.launch({
        owner: "octo",
        repo: "demo",
        issueNumber: 7,
        slug: "fix-bug",
        repoPath: "/repo",
        worktreePath: "/worktree",
        launchFlags: [],
        promptRelativePath: ".pi/conductor/run/initial-prompt.md",
      }),
    ).resolves.toMatchObject({ tabId: "t2", paneId: "p2" });
    expect(calls).toEqual(expect.arrayContaining([["tab", "close", "t1"]]));
  });

  test("parses gh JSON outputs", () => {
    expect(parseGhUser('{"login":"octo"}').login).toBe("octo");
    expect(
      parseGhRepoView('{"nameWithOwner":"octo/demo","defaultBranchRef":{"name":"main"}}')
        .defaultBranchRef.name,
    ).toBe("main");
    expect(
      parseGhIssueView(
        JSON.stringify({
          id: "I_1",
          number: 7,
          title: "Fix bug",
          body: null,
          url: "https://github.com/octo/demo/issues/7",
          labels: [{ name: "ready" }],
          assignees: [{ login: "octo" }],
        }),
      ).labels[0]?.name,
    ).toBe("ready");
    expect(
      parseGhPullRequestList(
        JSON.stringify([
          { number: 4, url: "https://pr", headRefName: "pi/7-fix", state: "OPEN", isDraft: false },
        ]),
      )[0]?.url,
    ).toBe("https://pr");
    expect(parseProjectItemsGraphql(projectItemsGraphqlFixture())[0]).toMatchObject({
      projectItemId: "PVTI_1",
      projectId: "PVT_1",
      owner: "octo",
      repo: "demo",
      issueNumber: 7,
      labels: ["ready"],
      assignees: ["octo"],
      projectStatus: "Todo",
      projectFields: { Status: "Todo", Priority: "High" },
    });
    expect(
      parseGhPrChecks(
        JSON.stringify([{ name: "test", conclusion: "failure", link: "https://ci" }]),
      ),
    ).toMatchObject([
      {
        key: "check:test:failure:https://ci",
        kind: "check",
        body: "Check test is failure.",
        url: "https://ci",
        check: { name: "test", conclusion: "failure" },
      },
    ]);
    expect(
      parseGhPrChecks(JSON.stringify([{ name: "pending", bucket: "pending", state: "PENDING" }])),
    ).toEqual([]);
    expect(
      parseGhPrViewFeedback(
        JSON.stringify({
          reviewDecision: "CHANGES_REQUESTED",
          comments: [{ id: "c1", body: "Please fix", author: { login: "reviewer" } }],
          reviews: [],
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "comment:c1", kind: "comment", author: "reviewer" }),
        expect.objectContaining({ key: "review-decision:CHANGES_REQUESTED", kind: "review" }),
      ]),
    );
    expect(parseGhReviewComments(JSON.stringify([{ id: "rc1", body: "Inline" }]))).toMatchObject([
      { key: "review_comment:rc1", kind: "review_comment" },
    ]);
    expect(
      parseGhReviewComments(JSON.stringify([[{ id: "rc2", body: "Inline 2" }]])),
    ).toMatchObject([{ key: "review_comment:rc2", kind: "review_comment" }]);
    expect(parseGhIssueComments(JSON.stringify([{ id: "ic1", body: "Issue note" }]))).toMatchObject(
      [{ key: "issue_comment:ic1", kind: "issue_comment" }],
    );
  });

  test("gh PR branch lookup includes merged and closed PRs", async () => {
    const calls: string[][] = [];
    const client = new GhGitHubClient(async (_file, args) => {
      calls.push(args);
      return {
        stdout: JSON.stringify([
          {
            number: 1,
            url: "https://github.com/octo/demo/pull/1",
            headRefName: "pi/7-fix-bug",
            state: "MERGED",
            isDraft: false,
            mergedAt: "2026-07-05T00:00:00Z",
            closingIssuesReferences: [{ number: 7 }],
          },
        ]),
        stderr: "",
      };
    });
    await expect(
      client.findPullRequestByBranch("octo", "demo", "pi/7-fix-bug"),
    ).resolves.toMatchObject({
      number: 1,
      mergedAt: "2026-07-05T00:00:00Z",
    });
    expect(calls[0]).toEqual(
      expect.arrayContaining(["pr", "list", "--head", "pi/7-fix-bug", "--state", "all"]),
    );
  });

  test("authenticated review feedback routes unless it has conductor marker", async () => {
    const client = new GhGitHubClient(async (_file, args) => {
      if (args.includes("checks")) return { stdout: "[]", stderr: "" };
      if (args.includes("view")) {
        return {
          stdout: JSON.stringify({
            comments: [],
            reviewDecision: "",
            reviews: [
              {
                id: "PRR_1",
                body: "Static screenshot is not proof. Send a video.",
                author: { login: "octo" },
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args.at(-1) === "repos/octo/demo/pulls/2/comments") {
        return { stdout: "[]", stderr: "" };
      }
      if (args.at(-1) === "repos/octo/demo/issues/7/comments") {
        return {
          stdout: JSON.stringify([
            [{ id: "ic1", body: "<!-- pi-conductor -->\nPi Conductor associated PR." }],
          ]),
          stderr: "",
        };
      }
      throw new Error(`unexpected gh args: ${args.join(" ")}`);
    });

    await expect(client.listPullRequestFeedback("octo", "demo", 2, 7, ["octo"])).resolves.toEqual([
      expect.objectContaining({
        key: "review:PRR_1",
        author: "octo",
        body: "Static screenshot is not proof. Send a video.",
      }),
    ]);
  });

  test("conductor issue comments carry an html marker", async () => {
    const calls: string[][] = [];
    const client = new GhGitHubClient(async (_file, args) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    });

    await client.commentIssue(workItem(), "Pi Conductor associated PR: https://github.com/pull/1");

    expect(calls[0]).toEqual(
      expect.arrayContaining([
        "issue",
        "comment",
        "7",
        "--body",
        "Pi Conductor associated PR: https://github.com/pull/1\n\n<!-- pi-conductor -->",
      ]),
    );
  });

  test("project item query resolves org owner before GraphQL project lookup", async () => {
    const graphqlQueries: string[] = [];
    const client = new GhGitHubClient(async (_file, args) => {
      if (args[0] === "api" && args[1] === "users/xirune") {
        return { stdout: JSON.stringify({ type: "Organization" }), stderr: "" };
      }
      if (args[0] === "api" && args[1] === "graphql") {
        const query = args.find((arg) => arg.startsWith("query=")) ?? "";
        graphqlQueries.push(query);
        if (query.includes("organization(login:") && query.includes("user(login:")) {
          throw new Error("gh: Could not resolve to a User with the login of 'xirune'.");
        }
        return { stdout: projectItemsGraphqlFixture(), stderr: "" };
      }
      throw new Error(`unexpected gh args: ${args.join(" ")}`);
    });

    await expect(
      client.listProjectItems(
        managedRepo({ project: { owner: "xirune", number: 1 }, repoPath: "/repo" }),
      ),
    ).resolves.toHaveLength(1);
    expect(graphqlQueries).toHaveLength(1);
    expect(graphqlQueries[0]).toContain("organization(login:");
    expect(graphqlQueries[0]).not.toContain("user(login:");
  });

  test("plans worktree commands with mocked git", async () => {
    const tempDir = await createTempDir("conductor-worktree-");
    const calls: string[][] = [];
    const exec: WorktreeExec = async (_file, args) => {
      calls.push(args);
      if (args.includes("rev-parse")) throw new Error("missing branch");
      return { stdout: "", stderr: "" };
    };
    const manager = new WorktreeManager(exec);
    const config = resolveRepositoryConfig(managedRepo(), {}, {}, tempDir);
    const plan = manager.plan(config, workItem(), "main");
    await manager.prepare(config, plan);
    expect(plan.branch).toBe("pi/7-fix-bug");
    expect(calls).toEqual([
      ["-C", "/repo", "fetch", "origin", "main"],
      ["-C", "/repo", "worktree", "list", "--porcelain"],
      ["-C", "/repo", "rev-parse", "--verify", "refs/heads/pi/7-fix-bug"],
      [
        "-C",
        "/repo",
        "worktree",
        "add",
        "-B",
        "pi/7-fix-bug",
        join(tempDir, "worktrees", "octo", "demo", "7"),
        "origin/main",
      ],
      ["-C", "/repo", "config", "--local", "--get-all", "pi.conductor.hook.postCreate"],
    ]);
  });

  test("runs shared and private worktree hooks", async () => {
    const tempDir = await createTempDir("conductor-worktree-hooks-");
    const calls: Array<{ file: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }> =
      [];
    let registeredWorktree = "";
    const exec: WorktreeExec = async (file, args, options) => {
      calls.push({ file, args, cwd: options.cwd, env: options.env });
      if (args.includes("rev-parse")) throw new Error("missing branch");
      if (args.includes("worktree") && args.includes("list")) {
        return {
          stdout: registeredWorktree.length === 0 ? "" : `worktree ${registeredWorktree}\n`,
          stderr: "",
        };
      }
      if (args.includes("worktree") && args.includes("add")) {
        registeredWorktree = String(args[args.length - 2]);
        await mkdir(registeredWorktree, { recursive: true });
      }
      if (args.includes("config")) {
        if (args.at(-1) === "pi.conductor.hook.postCreate") {
          return { stdout: "echo local-create\n", stderr: "" };
        }
        if (args.at(-1) === "pi.conductor.hook.preRemove") {
          return { stdout: "echo local-remove\n", stderr: "" };
        }
        if (args.at(-1) === "pi.conductor.hook.postRemove") {
          return { stdout: "echo local-removed\n", stderr: "" };
        }
      }
      return { stdout: "", stderr: "" };
    };
    const manager = new WorktreeManager(exec);
    const config = resolveRepositoryConfig(
      managedRepo(),
      {
        worktreeHooks: {
          postCreate: ["echo shared-create"],
          preRemove: ["echo shared-remove"],
          postRemove: ["echo shared-removed"],
        },
      },
      {},
      tempDir,
    );
    const plan = manager.plan(config, workItem(), "main");

    await manager.prepare(config, plan);
    await manager.cleanupLocal(config, plan, { allowDirty: true });

    const hookCalls = calls.filter((call) => call.file !== "git");
    expect(hookCalls.map((call) => call.args.at(-1))).toEqual([
      "echo shared-create",
      "echo local-create",
      "echo shared-remove",
      "echo local-remove",
      "echo shared-removed",
      "echo local-removed",
    ]);
    expect(hookCalls[0]).toMatchObject({ cwd: plan.worktreePath });
    expect(hookCalls[0]?.env).toMatchObject({
      REPO_ROOT: "/repo",
      WORKTREE_PATH: plan.worktreePath,
      BRANCH: plan.branch,
      PI_CONDUCTOR_OWNER: "octo",
      PI_CONDUCTOR_REPO: "demo",
      PI_CONDUCTOR_ISSUE_NUMBER: "7",
    });
    expect(hookCalls.at(-1)).toMatchObject({ cwd: "/repo" });
  });

  test("cleanup removes stale non-git worktree directory", async () => {
    const tempDir = await createTempDir("conductor-stale-worktree-");
    const calls: string[][] = [];
    const exec: WorktreeExec = async (_file, args) => {
      calls.push(args);
      if (args.includes("remove")) throw new Error("not a registered worktree");
      if (args.includes("rev-parse")) throw new Error("missing branch");
      return { stdout: "", stderr: "" };
    };
    const manager = new WorktreeManager(exec);
    const config = resolveRepositoryConfig(managedRepo(), {}, {}, tempDir);
    const plan = manager.plan(config, workItem(), "main");
    await mkdir(plan.worktreePath, { recursive: true });
    await writeFile(join(plan.worktreePath, "stale.txt"), "stale");

    await manager.cleanupLocal(config, plan);

    expect(calls.some((args) => args.includes("status"))).toBe(false);
    await expect(readFile(join(plan.worktreePath, "stale.txt"), "utf8")).rejects.toThrow();
  });
});

describe("herdr background placement", () => {
  test("background shell tabs use current Herdr workspace", async () => {
    const previousWorkspaceId = process.env.HERDR_WORKSPACE_ID;
    process.env.HERDR_WORKSPACE_ID = "w-run";
    const calls: Array<{ args: string[]; command: string }> = [];
    const backend = new HerdrBackgroundShellBackend(async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "tab") {
        return {
          stdout: JSON.stringify({ result: { root_pane: { pane_id: "w-run:p2" } } }),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });
    try {
      await backend.launch({
        command: "npm test",
        cwd: "/worktree",
        description: "Runs tests",
        exitFile: "/tmp/run.exit",
        id: "run-1",
        label: "npm test",
        outputFile: "/tmp/run.out",
        scriptPath: "/tmp/run.sh",
        startedAt: 0,
      });
    } finally {
      restoreEnv("HERDR_WORKSPACE_ID", previousWorkspaceId);
    }

    expect(calls[0]?.args).toEqual(
      expect.arrayContaining(["tab", "create", "--workspace", "w-run"]),
    );
  });

  test("subagent window panes use current Herdr workspace", async () => {
    const previousWorkspaceId = process.env.HERDR_WORKSPACE_ID;
    process.env.HERDR_WORKSPACE_ID = "w-run";
    const calls: string[][] = [];
    const adapter = new HerdrAdapter(async (_command, args) => {
      calls.push(args);
      if (args[0] === "tab") {
        return {
          code: 0,
          stdout: JSON.stringify({ result: { root_pane: { pane_id: "w-run:p3" } } }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    }, "/repo");
    try {
      await adapter.createPane({
        command: "pi --mode worker",
        cwd: "/worktree",
        target: "window",
        title: "worker",
      });
    } finally {
      restoreEnv("HERDR_WORKSPACE_ID", previousWorkspaceId);
    }

    expect(calls[0]).toEqual(expect.arrayContaining(["tab", "create", "--workspace", "w-run"]));
  });
});

describe("conductor orchestrator", () => {
  test("manual run creates worktree prompt and launches Herdr with fake adapters", async () => {
    const tempDir = await createTempDir("conductor-run-");
    const repoPath = join(tempDir, "repo");
    await mkdir(join(repoPath, ".pi"), { recursive: true });
    await writeFile(
      join(repoPath, ".pi", "WORKFLOW.md"),
      [
        "---",
        "launchRules:",
        "  - if: \"${{ contains(github.issue.labels, 'ready') }}\"",
        '    flags: ["--mode-deep"]',
        "---",
        "Do ${{ github.issue.title }} on ${{ conductor.branch }}",
      ].join("\n"),
    );

    const config = configWithRepo(
      managedRepo({ repoPath, project: { owner: "octo", number: 1 } }),
      tempDir,
    );
    const store = new MemoryConductorStore();
    await store.init();
    const github = new FakeGitHub(workItem());
    const herdr = new FakeHerdr();
    const worktrees = new WorktreeManager(async (_file, args) => {
      if (args.includes("rev-parse")) throw new Error("missing branch");
      if (args.includes("worktree") && args.includes("add")) {
        await mkdir(String(args[args.length - 2]), { recursive: true });
      }
      return { stdout: "", stderr: "" };
    });

    const orchestrator = new ConductorOrchestrator({
      config,
      store,
      github,
      herdr,
      worktrees,
      cwd: repoPath,
      now: () => new Date("2026-07-05T00:00:00.000Z"),
    });

    const run = await orchestrator.run("octo/demo#7");
    const prompt = await readFile(run.promptPath, "utf8");

    expect(run.status).toBe("in_progress");
    expect(run.launchFlags).toEqual(["--mode-deep"]);
    expect(github.statusUpdates).toEqual(["In Progress"]);
    expect(herdr.launches[0]).toMatchObject({
      owner: "octo",
      repo: "demo",
      issueNumber: 7,
      launchFlags: ["--mode-deep"],
    });
    expect(prompt).toContain("Do Fix bug on pi/7-fix-bug");
    expect(await store.getActiveRun("octo", "demo", 7)).toMatchObject({ runId: run.runId });

    github.pr = {
      number: 2,
      url: "https://github.com/octo/demo/pull/2",
      headRefName: run.branch,
      state: "OPEN",
      isDraft: false,
    };
    github.feedback = [{ key: "check:test:failure", kind: "check", body: "Check test failed." }];
    await orchestrator.reconcile();

    expect(herdr.sent).toEqual([
      expect.objectContaining({
        delivery: "followUp",
        message: expect.stringContaining("Check test failed"),
      }),
    ]);
    expect(await store.getRun(run.runId)).toMatchObject({
      status: "in_review",
      prNumber: 2,
      prUrl: "https://github.com/octo/demo/pull/2",
      routedFeedbackKeys: ["check:test:failure"],
    });

    const stopped = await orchestrator.stop(run.runId);
    expect(stopped.status).toBe("blocked");
    expect(github.statusUpdates).toEqual(["In Progress", "Review", "Blocked"]);
    expect(github.comments.at(-1)).toContain("stopped run");
    expect(herdr.stopCount).toBe(1);
  });

  test("follow-up rules customize feedback messages and delivery", async () => {
    const tempDir = await createTempDir("conductor-followup-rules-");
    const repoPath = join(tempDir, "repo");
    await mkdir(join(repoPath, ".pi"), { recursive: true });
    await writeFile(
      join(repoPath, ".pi", "WORKFLOW.md"),
      [
        "---",
        "followUpRules:",
        "  - name: review body",
        "    if: \"${{ feedback.kind == 'review' }}\"",
        "    delivery: followUp",
        "    template: |",
        "      Review says: ${{ github.review.body }}",
        "  - name: urgent pr",
        "    delivery: steer",
        "    template: |",
        "      PR: ${{ github.pull_request.url }}",
        "  - name: feedback author",
        "    delivery: steer",
        "    template: |",
        "      Author: ${{ feedback.author }}",
        "conductorComments:",
        "  prAssociated:",
        '    template: "Custom PR associated: ${{ github.pull_request.url }}"',
        "---",
        "Do it",
      ].join("\n"),
    );
    const store = new MemoryConductorStore();
    await store.init();
    const run = runRecord({
      owner: "octo",
      repo: "demo",
      issueNumber: 7,
      branch: "pi/7-fix-bug",
      status: "in_progress",
      herdr: { paneId: "p1" },
    });
    await store.createRun(run);
    const github = new FakeGitHub(workItem());
    github.pr = {
      number: 2,
      url: "https://github.com/octo/demo/pull/2",
      headRefName: run.branch,
      state: "OPEN",
      isDraft: false,
    };
    github.feedback = [
      {
        key: "review:PRR_1",
        kind: "review",
        body: "Need a video.",
        author: "reviewer",
        review: { id: "PRR_1", body: "Need a video.", author: "reviewer" },
      },
    ];
    const herdr = new FakeHerdr();
    const orchestrator = new ConductorOrchestrator({
      config: configWithRepo(managedRepo({ repoPath }), tempDir),
      store,
      github,
      herdr,
      cwd: repoPath,
    });

    await orchestrator.reconcile();

    expect(github.comments).toEqual(["Custom PR associated: https://github.com/octo/demo/pull/2"]);
    expect(herdr.sent).toEqual([
      expect.objectContaining({
        delivery: "followUp",
        message: expect.stringContaining("Review says: Need a video."),
      }),
      expect.objectContaining({
        delivery: "steer",
        message: expect.stringContaining(
          "PR: https://github.com/octo/demo/pull/2\n\nAuthor: reviewer",
        ),
      }),
    ]);
    expect(herdr.sent[0]?.message).toContain("<!-- pi-conductor -->");
    expect(herdr.sent[1]?.message).toContain("<!-- pi-conductor -->");
  });

  test("automated reconcile does not restart completed work", async () => {
    const tempDir = await createTempDir("conductor-done-reconcile-");
    const repoPath = join(tempDir, "repo");
    await mkdir(repoPath, { recursive: true });
    const store = new MemoryConductorStore();
    await store.init();
    await store.createRun(
      runRecord({ owner: "octo", repo: "demo", issueNumber: 7, status: "done" }),
    );
    const github = new FakeGitHub(workItem({ labels: ["ready-for-agent"], assignees: ["octo"] }));
    const herdr = new FakeHerdr();
    const orchestrator = new ConductorOrchestrator({
      config: configWithRepo(managedRepo({ repoPath }), tempDir),
      store,
      github,
      herdr,
      cwd: repoPath,
    });

    await expect(orchestrator.reconcile()).resolves.toEqual([]);
    expect(herdr.launches).toHaveLength(0);
    expect(await store.listRuns()).toHaveLength(1);
  });

  test("cleanup keeps completed run status when cleaning local state", async () => {
    const tempDir = await createTempDir("conductor-done-cleanup-");
    const repoPath = join(tempDir, "repo");
    await mkdir(repoPath, { recursive: true });
    const store = new MemoryConductorStore();
    await store.init();
    const run = runRecord({
      owner: "octo",
      repo: "demo",
      issueNumber: 7,
      status: "done",
      worktreePath: join(tempDir, "worktrees", "octo", "demo", "7"),
    });
    await mkdir(run.worktreePath, { recursive: true });
    await store.createRun(run);
    const github = new FakeGitHub(workItem());
    const orchestrator = new ConductorOrchestrator({
      config: configWithRepo(managedRepo({ repoPath }), tempDir),
      store,
      github,
      herdr: new FakeHerdr(),
      worktrees: new WorktreeManager(async (_file, args) => {
        if (args.includes("remove")) throw new Error("stale worktree");
        if (args.includes("rev-parse")) throw new Error("missing branch");
        return { stdout: "", stderr: "" };
      }),
      cwd: repoPath,
    });

    await expect(orchestrator.cleanup(run.runId, false)).resolves.toMatchObject({ status: "done" });
    await expect(store.getRun(run.runId)).resolves.toMatchObject({ status: "done" });
  });

  test("automated reconcile ignores project items from other repositories", async () => {
    const tempDir = await createTempDir("conductor-cross-repo-");
    const repoPath = join(tempDir, "repo");
    await mkdir(repoPath, { recursive: true });
    const store = new MemoryConductorStore();
    await store.init();
    const github = new FakeGitHub(workItem({ owner: "octo", repo: "other" }));
    const herdr = new FakeHerdr();
    const orchestrator = new ConductorOrchestrator({
      config: configWithRepo(managedRepo({ repoPath }), tempDir),
      store,
      github,
      herdr,
      cwd: repoPath,
    });

    await expect(orchestrator.reconcile()).resolves.toEqual([]);
    expect(herdr.launches).toHaveLength(0);
    expect(await store.listRuns()).toEqual([]);
  });

  test("automated reconcile does not restart blocked work", async () => {
    const tempDir = await createTempDir("conductor-blocked-reconcile-");
    const repoPath = join(tempDir, "repo");
    await mkdir(repoPath, { recursive: true });
    const store = new MemoryConductorStore();
    await store.init();
    await store.createRun(runRecord({ status: "blocked", updatedAt: "2026-07-04T00:00:00.000Z" }));
    const github = new FakeGitHub(workItem());
    const herdr = new FakeHerdr();
    const orchestrator = new ConductorOrchestrator({
      config: configWithRepo(managedRepo({ repoPath }), tempDir),
      store,
      github,
      herdr,
      cwd: repoPath,
      now: () => new Date("2026-07-05T02:00:00.000Z"),
    });

    await expect(orchestrator.reconcile()).resolves.toEqual([]);
    expect(herdr.launches).toHaveLength(0);
  });

  test("merged PR finalizes run and rejects merged cleanup for active runs", async () => {
    const tempDir = await createTempDir("conductor-merged-");
    const repoPath = join(tempDir, "repo");
    await mkdir(repoPath, { recursive: true });
    const store = new MemoryConductorStore();
    await store.init();
    const run = runRecord({ worktreePath: join(tempDir, "worktrees", "octo", "demo", "7") });
    await store.createRun(run);
    const calls: string[][] = [];
    const worktrees = new WorktreeManager(async (_file, args) => {
      calls.push(args);
      if (args.includes("ls-remote"))
        return { stdout: "abc\trefs/heads/pi/7-fix-bug\n", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const github = new FakeGitHub(workItem());
    github.pr = {
      number: 2,
      url: "https://github.com/octo/demo/pull/2",
      headRefName: run.branch,
      state: "MERGED",
      isDraft: false,
      mergedAt: "2026-07-05T00:00:00Z",
      linkedIssueNumbers: [7],
    };
    const orchestrator = new ConductorOrchestrator({
      config: configWithRepo(managedRepo({ repoPath }), tempDir),
      store,
      github,
      herdr: new FakeHerdr(),
      worktrees,
      cwd: repoPath,
    });

    await expect(orchestrator.cleanup(run.runId, true)).rejects.toThrow("Merged cleanup requires");
    await orchestrator.reconcile();
    await expect(store.getRun(run.runId)).resolves.toMatchObject({ status: "done", prNumber: 2 });
    expect(calls).toEqual(
      expect.arrayContaining([["-C", repoPath, "push", "origin", "--delete", "pi/7-fix-bug"]]),
    );
  });

  test("retry recovery prompt includes prior run state and PR feedback", async () => {
    const tempDir = await createTempDir("conductor-retry-");
    const repoPath = join(tempDir, "repo");
    await mkdir(repoPath, { recursive: true });
    const store = new MemoryConductorStore();
    await store.init();
    const run = runRecord({
      status: "blocked",
      prNumber: 2,
      prUrl: "https://github.com/octo/demo/pull/2",
      lastError: "CI failed",
      worktreePath: join(tempDir, "worktrees", "octo", "demo", "7"),
    });
    await store.createRun(run);
    const github = new FakeGitHub(workItem());
    github.feedback = [{ key: "check:test:failure", kind: "check", body: "Check test failed." }];
    const worktrees = new WorktreeManager(async (_file, args) => {
      if (args.includes("worktree") && args.includes("add")) {
        await mkdir(String(args[args.length - 2]), { recursive: true });
      }
      if (args.includes("rev-parse")) throw new Error("missing branch");
      return { stdout: "", stderr: "" };
    });
    const orchestrator = new ConductorOrchestrator({
      config: configWithRepo(managedRepo({ repoPath }), tempDir),
      store,
      github,
      herdr: new FakeHerdr(),
      worktrees,
      cwd: repoPath,
    });

    const retried = await orchestrator.retry(run.runId);
    const prompt = await readFile(retried.promptPath, "utf8");
    expect(prompt).toContain("Previous run state");
    expect(prompt).toContain("- PR: https://github.com/octo/demo/pull/2");
    expect(prompt).toContain("- Last error: CI failed");
    expect(prompt).toContain("Check test failed");
  });

  test("missing Herdr session recovery prepares the worktree before relaunch", async () => {
    const tempDir = await createTempDir("conductor-herdr-recovery-");
    const repoPath = join(tempDir, "repo");
    await mkdir(repoPath, { recursive: true });
    const store = new MemoryConductorStore();
    await store.init();
    const run = runRecord({
      herdr: { paneId: "missing" },
      worktreePath: join(tempDir, "worktrees", "octo", "demo", "7"),
    });
    await store.createRun(run);
    const calls: string[][] = [];
    const worktrees = new WorktreeManager(async (_file, args) => {
      calls.push(args);
      if (args.includes("worktree") && args.includes("add")) {
        await mkdir(String(args[args.length - 2]), { recursive: true });
      }
      if (args.includes("rev-parse")) throw new Error("missing branch");
      return { stdout: "", stderr: "" };
    });
    const herdr = new FakeHerdr();
    herdr.paneExistsResult = false;
    const orchestrator = new ConductorOrchestrator({
      config: configWithRepo(managedRepo({ repoPath }), tempDir),
      store,
      github: new FakeGitHub(workItem()),
      herdr,
      worktrees,
      cwd: repoPath,
    });

    await orchestrator.reconcile();

    expect(calls).toEqual(
      expect.arrayContaining([
        ["-C", repoPath, "fetch", "origin", "main"],
        expect.arrayContaining(["worktree", "add", "-B", "pi/7-fix-bug"]),
      ]),
    );
    expect(herdr.launches).toHaveLength(1);
    expect(
      await readFile(
        join(run.worktreePath, ".pi", "conductor", "run", "initial-prompt.md"),
        "utf8",
      ),
    ).toContain("Recovery attempt");
  });

  test("retry rejects completed runs", async () => {
    const store = new MemoryConductorStore();
    await store.init();
    await store.createRun(runRecord({ status: "done" }));
    const orchestrator = new ConductorOrchestrator({
      config: configWithRepo(managedRepo()),
      store,
      github: new FakeGitHub(workItem()),
      herdr: new FakeHerdr(),
      cwd: "/repo",
    });

    await expect(orchestrator.retry("run-1")).rejects.toThrow("Cannot retry completed run");
  });

  test("scoped PR reconcile uses webhook PR payload without project scan", async () => {
    const tempDir = await createTempDir("conductor-scoped-pr-");
    const repoPath = join(tempDir, "repo");
    await mkdir(repoPath, { recursive: true });
    const store = new MemoryConductorStore();
    await store.init();
    const run = runRecord({ status: "in_progress" });
    await store.createRun(run);
    const github = new FakeGitHub(workItem());
    const orchestrator = new ConductorOrchestrator({
      config: configWithRepo(managedRepo({ repoPath }), tempDir),
      store,
      github,
      herdr: new FakeHerdr(),
      cwd: repoPath,
    });

    await orchestrator.reconcile({
      owner: "octo",
      repo: "demo",
      prNumber: 2,
      branch: run.branch,
      pullRequest: {
        number: 2,
        url: "https://github.com/octo/demo/pull/2",
        headRefName: run.branch,
        state: "OPEN",
        isDraft: false,
      },
    });

    await expect(store.getRun(run.runId)).resolves.toMatchObject({
      status: "in_review",
      prNumber: 2,
    });
    expect(github.listProjectItemsCount).toBe(0);
    expect(github.findPullRequestByBranchCount).toBe(0);
  });
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolveValue: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  return { promise, resolve: resolveValue };
}

function writableCapture(): { write(value: string): void; text(): string } {
  const chunks: string[] = [];
  return {
    write(value: string) {
      chunks.push(value);
    },
    text() {
      return chunks.join("");
    },
  };
}

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content);
  await chmod(path, 0o755);
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function postWebhook(
  port: number,
  path: string,
  secret: string,
  eventName: string,
  deliveryId: string,
  payload: unknown,
): Promise<{ statusCode: number; body: string }> {
  const body = Buffer.from(JSON.stringify(payload));
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return new Promise((resolve, reject) => {
    const webhookRequest = request(
      {
        method: "POST",
        host: "127.0.0.1",
        port,
        path,
        headers: {
          "content-type": "application/json",
          "content-length": body.byteLength,
          "x-github-delivery": deliveryId,
          "x-github-event": eventName,
          "x-hub-signature-256": signature,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    webhookRequest.on("error", reject);
    webhookRequest.end(body);
  });
}

class FakeGitHub implements GitHubClient {
  readonly statusUpdates: string[] = [];
  readonly comments: string[] = [];
  listProjectItemsCount = 0;
  findPullRequestByBranchCount = 0;
  pr: PullRequestSummary | undefined;
  feedback: PullRequestFeedback[] = [];

  constructor(private readonly item: WorkItem) {}

  async getAuthenticatedUser(): Promise<string> {
    return "octo";
  }

  async getRepository(): Promise<{ owner: string; repo: string; defaultBranch: string }> {
    return { owner: "octo", repo: "demo", defaultBranch: "main" };
  }

  async resolveWorkItem(): Promise<WorkItem> {
    return this.item;
  }

  async listProjectItems(): Promise<WorkItem[]> {
    this.listProjectItemsCount += 1;
    return [this.item];
  }

  async updateProjectStatus(
    _repo: unknown,
    _workItem: WorkItem,
    statusName: string,
  ): Promise<void> {
    this.statusUpdates.push(statusName);
  }

  async commentIssue(_workItem: WorkItem, body: string): Promise<void> {
    this.comments.push(body);
  }

  async findPullRequestByBranch(): Promise<PullRequestSummary | undefined> {
    this.findPullRequestByBranchCount += 1;
    return this.pr;
  }

  async listPullRequestFeedback(): Promise<PullRequestFeedback[]> {
    return this.feedback;
  }
}

class FakeHerdr implements HerdrSessionManager {
  readonly launches: HerdrRunInput[] = [];
  readonly sent: Array<{ message: string; delivery: ConductorDeliveryMode }> = [];
  paneExistsResult = true;
  stopCount = 0;

  async launch(input: HerdrRunInput): Promise<HerdrHandles> {
    this.launches.push(input);
    return { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" };
  }

  async find(): Promise<HerdrHandles | undefined> {
    return undefined;
  }

  async send(
    _handles: HerdrHandles,
    message: string,
    delivery: ConductorDeliveryMode,
  ): Promise<void> {
    this.sent.push({ message, delivery });
  }

  async paneExists(): Promise<boolean> {
    return this.paneExistsResult;
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
  }
}

function managedRepo(
  overrides: Partial<GlobalConductorConfig["repositories"][number]> = {},
): GlobalConductorConfig["repositories"][number] {
  return {
    owner: "octo",
    repo: "demo",
    repoPath: "/repo",
    project: { owner: "octo", number: 1 },
    ...overrides,
  };
}

function configWithRepo(
  repo: GlobalConductorConfig["repositories"][number],
  stateRoot = "/state",
): GlobalConductorConfig {
  return { version: 1, stateRoot, pollingIntervalSeconds: 60, repositories: [repo] };
}

function workItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    projectItemId: "PVTI_1",
    projectId: "PVT_1",
    owner: "octo",
    repo: "demo",
    issueId: "I_1",
    issueNumber: 7,
    issueUrl: "https://github.com/octo/demo/issues/7",
    title: "Fix bug",
    body: "Body",
    labels: ["ready", "ready-for-agent"],
    assignees: ["octo"],
    projectStatus: "Todo",
    projectFields: { Status: "Todo" },
    ...overrides,
  };
}

function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "run-1",
    owner: "octo",
    repo: "demo",
    issueNumber: 7,
    issueUrl: "https://github.com/octo/demo/issues/7",
    issueTitle: "Fix bug",
    projectItemId: "PVTI_1",
    projectId: "PVT_1",
    status: "in_progress",
    paused: false,
    attempt: 1,
    branch: "pi/7-fix-bug",
    baseRef: "main",
    worktreePath: "/state/worktrees/octo/demo/7",
    promptPath: "/state/worktrees/octo/demo/7/.pi/conductor/run/initial-prompt.md",
    launchFlags: [],
    herdr: {},
    createdAt: "2026-07-05T00:00:00.000Z",
    updatedAt: "2026-07-05T00:00:00.000Z",
    ...overrides,
  };
}

function readSqlitePragmaValue(dbPath: string, pragma: string): string {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare(`PRAGMA ${pragma}`).get();
    if (row !== null && typeof row === "object") {
      const value = Object.values(row)[0];
      if (typeof value === "string") return value;
    }
    throw new Error(`Unable to read SQLite pragma ${pragma}`);
  } finally {
    db.close();
  }
}

function projectItemsGraphqlFixture(): string {
  return JSON.stringify({
    data: {
      organization: {
        projectV2: {
          id: "PVT_1",
          items: {
            nodes: [
              {
                id: "PVTI_1",
                content: {
                  id: "I_1",
                  number: 7,
                  title: "Fix bug",
                  body: "Body",
                  url: "https://github.com/octo/demo/issues/7",
                  repository: { name: "demo", owner: { login: "octo" } },
                  labels: { nodes: [{ name: "ready" }] },
                  assignees: { nodes: [{ login: "octo" }] },
                },
                fieldValues: {
                  nodes: [
                    { name: "Todo", field: { name: "Status" } },
                    { name: "High", field: { name: "Priority" } },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  });
}
