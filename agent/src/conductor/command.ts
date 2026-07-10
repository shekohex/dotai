import { watch, type FSWatcher } from "node:fs";
import { access } from "node:fs/promises";
import { setTimeout, clearTimeout } from "node:timers";
import { join } from "node:path";

import {
  formatConfigError,
  getDefaultConfigPath,
  type ConfigInitResult,
  type GlobalConductorConfig,
  getStateRoot,
  initConfig,
  readGlobalConfig,
  readOptionalGlobalConfig,
  resolveRepositoryConfig,
  validateBranchTemplate,
  validateGlobalConfig,
} from "./config.js";
import { completionScript, helpText } from "./command-help.js";
import { readConductorDaemonStatus, startConductorDaemon, stopConductorDaemon } from "./daemon.js";
import { GhGitHubClient } from "./github.js";
import { CliHerdrSessionManager } from "./herdr.js";
import { ConsoleConductorLogger, type ConductorLogger, readRunLogs } from "./logging.js";
import { ConductorOrchestrator } from "./orchestrator.js";
import { createPollingPlans, startConductorPolling } from "./polling.js";
import { validateInitialPromptTemplate } from "./prompt.js";
import { SqliteConductorStore } from "./store/sqlite.js";
import type { ConductorStore } from "./store/types.js";
import { formatRunsJson, formatRunsTable } from "./status-format.js";
import { loadWorkflow, workflowConfigOverrides } from "./workflow.js";
import {
  parseConductorArgs,
  parseConductorVerbosity,
  type ParsedConductorCommand,
} from "./commands/parser.js";
import {
  editConductorConfig,
  formatConfigValue,
  formatConductorConfig,
  readConductorConfigValue,
  setConductorConfigValue,
} from "./config-access.js";
import { processPendingWebhookDeliveries, resolveWebhookSecret, serveWebhook } from "./webhook.js";

type Writable = { write(text: string): unknown };
type WebhookServer = { close(): Promise<void> };
type ConductorExecutionOptions = Required<ConductorCommandOptions> & { logger: ConductorLogger };

export type ConductorCommandOptions = {
  cwd: string;
  stdout?: Writable;
  stderr?: Writable;
};

export async function runConductorCommand(
  args: string[],
  options: ConductorCommandOptions,
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const logger = new ConsoleConductorLogger(stderr, parseConductorVerbosity(args));
  try {
    await executeConductorCommand(parseConductorArgs(args), { ...options, stdout, stderr, logger });
    return 0;
  } catch (error) {
    stderr.write(`${formatConfigError(error)}\n`);
    return 1;
  }
}

async function executeConductorCommand(
  command: ParsedConductorCommand,
  options: ConductorExecutionOptions,
): Promise<void> {
  if (command.kind === "help") {
    options.stdout.write(helpText(command.topic));
    return;
  }

  if (command.kind === "completion") {
    options.stdout.write(completionScript(command.shell));
    return;
  }

  if (command.kind === "config-init") {
    const result = await initConfig(options.cwd);
    options.stdout.write(formatConfigInitResult(result));
    return;
  }

  if (command.kind === "config-validate") {
    await validateConfigCommand(options.stdout);
    return;
  }

  if (command.kind === "config-format") {
    const result = await formatConductorConfig();
    options.stdout.write(`Formatted ${result.configPath}.\nSchema: ${result.schemaPath}\n`);
    return;
  }

  if (command.kind === "config-edit") {
    await editConductorConfig();
    options.stdout.write("Conductor config valid.\n");
    return;
  }

  if (command.kind === "config-get") {
    options.stdout.write(
      formatConfigValue(await readConductorConfigValue(command.path), command.json),
    );
    return;
  }

  if (command.kind === "config-set") {
    await setConductorConfigValue(command.path, command.value);
    options.stdout.write(`Set ${command.path}.\n`);
    return;
  }

  const config = await readOptionalGlobalConfig();
  if (command.kind === "daemon") {
    await executeDaemonCommand(command.action, config, options);
    return;
  }
  const stateRoot = getStateRoot(config);
  const store = await createStore(stateRoot);
  try {
    if (command.kind === "status" || command.kind === "runs") {
      const runs = await store.listRuns();
      options.stdout.write(command.json ? formatRunsJson(runs) : `${formatRunsTable(runs)}\n`);
      return;
    }
    if (command.kind === "logs") {
      const logs = await readRunLogs(stateRoot, command.runId);
      if (logs.length === 0) {
        options.stdout.write(`No logs for ${command.runId}.\n`);
        return;
      }
      options.stdout.write(logs.map((entry) => JSON.stringify(entry)).join("\n"));
      options.stdout.write("\n");
      return;
    }

    const loadedConfig = config ?? (await readGlobalConfig());
    const orchestrator = new ConductorOrchestrator({
      config: loadedConfig,
      store,
      github: new GhGitHubClient(undefined, options.logger, { store }),
      herdr: new CliHerdrSessionManager(),
      logger: options.logger,
      cwd: options.cwd,
    });

    await executeStatefulCommand(
      command,
      orchestrator,
      loadedConfig,
      loadedConfig.pollingIntervalSeconds ?? 60,
      store,
      options,
    );
  } finally {
    await store.close?.();
  }
}

function formatConfigInitResult(result: ConfigInitResult): string {
  const projectCommands = [
    `gh repo view ${result.repository} --json projectsV2 --jq '.projectsV2.nodes[] | "owner=\\(.owner.login) number=\\(.number) title=\\(.title)"'`,
    `gh project list --owner ${result.projectOwnerHint}`,
    `gh project list --owner ${result.projectOwnerHint} --format json --jq '.projects[] | "number=\\(.number) title=\\(.title)"'`,
    `gh project view <number> --owner <owner>`,
  ];
  return [
    `Config: ${result.configPath}`,
    `Schema: ${result.schemaPath}`,
    `Workflow: ${result.workflowPath}${result.createdWorkflow ? " created" : " exists"}`,
    `Repository: ${result.repository} ${result.repositoryAdded ? "added" : "updated"}`,
    `Managed repositories: ${result.repositoryCount}`,
    `Config migration: ${result.configMigrated ? "applied" : "no changes"}`,
    "",
    "Add another repository:",
    "  cd /path/to/another/repo",
    "  pi conductor config init",
    "  The command upserts the current GitHub repo into config.repositories.",
    "",
    result.projectInferred
      ? "Project owner/number inferred. Run `pi conductor config validate` to verify access."
      : "Project owner/number still needs editing in config.json.",
    "",
    "Find GitHub Projects v2 owner/number with gh:",
    ...projectCommands.map((command) => `  ${command}`),
    "",
    "Next actions:",
    "  1. Edit config.json: set repositories[].project.owner and repositories[].project.number.",
    "  2. Edit .pi/WORKFLOW.md for repo-specific prompt, labels, branchTemplate, and launch rules.",
    "  3. Run `pi conductor config validate`.",
    "  4. Run `pi conductor serve` or `pi conductor daemon start`.",
    "",
  ].join("\n");
}

async function executeDaemonCommand(
  action: "start" | "stop" | "restart" | "status",
  config: GlobalConductorConfig | undefined,
  options: ConductorExecutionOptions,
): Promise<void> {
  if (action === "start") {
    const loadedConfig = config ?? (await readGlobalConfig());
    await validateServeConfig(loadedConfig);
    options.stdout.write(
      formatDaemonStart(
        await startConductorDaemon({
          stateRoot: getStateRoot(loadedConfig),
          cwd: options.cwd,
        }),
      ),
    );
    return;
  }
  if (action === "restart") {
    const loadedConfig = config ?? (await readGlobalConfig());
    await validateServeConfig(loadedConfig);
    const stopped = await stopConductorDaemon(getStateRoot(loadedConfig));
    if (stopped.running) {
      throw new Error(`Conductor daemon pid ${stopped.pid} did not stop within 5s`);
    }
    options.stdout.write(
      formatDaemonStart(
        await startConductorDaemon({
          stateRoot: getStateRoot(loadedConfig),
          cwd: options.cwd,
        }),
      ),
    );
    return;
  }
  if (action === "stop") {
    const result = await stopConductorDaemon(getStateRoot(config));
    if (result.stopped) {
      options.stdout.write(`Conductor daemon stopped pid ${result.pid}.\n`);
      return;
    }
    options.stdout.write(
      result.running
        ? `Conductor daemon pid ${result.pid} did not stop within 5s.\n`
        : "Conductor daemon not running.\n",
    );
    return;
  }
  const status = await readConductorDaemonStatus(getStateRoot(config));
  options.stdout.write(
    [
      status.running ? `Conductor daemon running pid ${status.pid}.` : "Conductor daemon stopped.",
      `PID: ${status.pidPath}`,
      `Log: ${status.logPath}`,
      `Error log: ${status.errorLogPath}`,
      "",
    ].join("\n"),
  );
}

function formatDaemonStart(result: Awaited<ReturnType<typeof startConductorDaemon>>): string {
  return [
    result.started
      ? `Conductor daemon started pid ${result.pid}.`
      : `Conductor daemon already running pid ${result.pid}.`,
    `PID: ${result.pidPath}`,
    `Log: ${result.logPath}`,
    `Error log: ${result.errorLogPath}`,
    "",
  ].join("\n");
}

async function executeStatefulCommand(
  command: ParsedConductorCommand,
  orchestrator: ConductorOrchestrator,
  config: GlobalConductorConfig,
  pollingIntervalSeconds: number,
  store: ConductorStore,
  options: ConductorExecutionOptions,
): Promise<void> {
  if (command.kind === "reconcile") {
    const runs = await orchestrator.reconcile();
    options.stdout.write(`Dispatched ${runs.length} run(s).\n`);
    return;
  }
  if (command.kind === "run") {
    const run = await orchestrator.run(command.reference, {
      launchFlags: command.launchFlags,
      configOverrides: command.configOverrides,
    });
    options.stdout.write(`${formatRunsTable([run])}\n`);
    return;
  }
  if (command.kind === "send") {
    await orchestrator.send(command.runId, command.message, command.delivery);
    options.stdout.write(`Sent ${command.delivery} to ${command.runId}.\n`);
    return;
  }
  if (command.kind === "stop") {
    const run = await orchestrator.stop(command.runId);
    options.stdout.write(`${formatRunsTable([run])}\n`);
    return;
  }
  if (command.kind === "pause") {
    const run = await orchestrator.pause(command.runId);
    options.stdout.write(`${formatRunsTable([run])}\n`);
    return;
  }
  if (command.kind === "resume") {
    const run = await orchestrator.resume(command.runId);
    options.stdout.write(`${formatRunsTable([run])}\n`);
    return;
  }
  if (command.kind === "retry") {
    const run = await orchestrator.retry(command.runId);
    options.stdout.write(`${formatRunsTable([run])}\n`);
    return;
  }
  if (command.kind === "cleanup") {
    const run = await orchestrator.cleanup(command.runId, command.merged);
    options.stdout.write(`${formatRunsTable([run])}\n`);
    return;
  }
  if (command.kind === "cleanup-merged") {
    const runs = await orchestrator.cleanupMergedRuns();
    options.stdout.write(`Cleaned ${runs.length} merged run(s).\n`);
    return;
  }
  if (command.kind === "cleanup-failed") {
    const runs = await orchestrator.cleanupFailedRuns();
    options.stdout.write(`Cleaned ${runs.length} failed run(s).\n`);
    return;
  }
  if (command.kind === "cleanup-gc") {
    const result = await store.gc({
      ...(command.olderThanDays === undefined ? {} : { olderThanDays: command.olderThanDays }),
      vacuum: command.vacuum,
    });
    options.stdout.write(
      [
        `Deleted ${result.deletedEvents} old event(s).`,
        `Deleted ${result.deletedDeliveries} old webhook delivery record(s).`,
        `WAL checkpoint: ${result.walCheckpointed ? "yes" : "no"}.`,
        `VACUUM: ${result.vacuumed ? "yes" : "no"}.`,
        "",
      ].join("\n"),
    );
    return;
  }
  if (command.kind === "serve") {
    await serve(orchestrator, config, pollingIntervalSeconds, store, options);
  }
}

async function serve(
  orchestrator: ConductorOrchestrator,
  config: GlobalConductorConfig,
  pollingIntervalSeconds: number,
  store: ConductorStore,
  options: ConductorExecutionOptions,
): Promise<void> {
  options.logger.info("Conductor serve starting", {
    repositories: config.repositories.length,
    pollingPlans: createPollingPlans(config),
    webhook: config.webhook !== undefined,
  });
  const validationStartedAt = Date.now();
  await validateServeConfig(config);
  options.logger.info("Conductor serve config valid", {
    durationMs: Date.now() - validationStartedAt,
  });
  let currentConfig = config;
  let webhook = await startWebhook(currentConfig, store, orchestrator, options.logger);
  startPendingWebhookRecovery(orchestrator, store, options.logger);
  let polling = startConductorPolling({
    config: currentConfig,
    logger: options.logger,
    orchestrator,
    store,
  });
  await polling.ready;
  options.logger.info("Conductor polling scheduler ready", {
    plans: createPollingPlans(currentConfig).length,
  });
  const reloader = createConfigReloader({
    getConfig: () => currentConfig,
    logger: options.logger,
    onReload: async (nextConfig) => {
      if (getStateRoot(nextConfig) !== getStateRoot(currentConfig)) {
        throw new Error("Changing conductor stateRoot requires restarting pi conductor serve");
      }
      const reloadStartedAt = Date.now();
      options.logger.info("Conductor config reload started");
      await validateServeConfig(nextConfig);
      orchestrator.updateConfig(nextConfig);
      currentConfig = nextConfig;
      polling.close();
      await webhook?.close();
      webhook = await startWebhook(currentConfig, store, orchestrator, options.logger);
      startPendingWebhookRecovery(orchestrator, store, options.logger);
      polling = startConductorPolling({
        config: currentConfig,
        forceInitial: true,
        logger: options.logger,
        orchestrator,
        store,
      });
      await polling.ready;
      options.logger.info("Conductor config reload complete", {
        durationMs: Date.now() - reloadStartedAt,
        repositories: currentConfig.repositories.length,
      });
    },
  });
  options.stdout.write(
    `Pi Conductor serving ${currentConfig.repositories.length} repo(s). Fallback poll ${pollingIntervalSeconds}s.\n`,
  );
  options.logger.info("Conductor serve ready", {
    repositories: currentConfig.repositories.length,
    synchronization: "background",
  });
  await waitForShutdown();
  options.logger.info("Conductor serve shutting down");
  reloader.close();
  polling.close();
  await webhook?.close();
}

function startWebhook(
  config: GlobalConductorConfig,
  store: ConductorStore,
  orchestrator: ConductorOrchestrator,
  logger: ConductorLogger,
): Promise<WebhookServer | undefined> {
  const noWebhook: WebhookServer | undefined = undefined;
  if (config.webhook === undefined) {
    logger.info("Conductor webhook disabled");
    return Promise.resolve(noWebhook);
  }
  return serveWebhook({
    config: config.webhook,
    store,
    orchestrator,
    repositories: config.repositories,
    logger,
  }).then((server) => {
    logger.info("Conductor webhook listening", {
      host: config.webhook?.host,
      port: server.port,
      path: config.webhook?.path,
    });
    return server;
  });
}

function createConfigReloader(input: {
  getConfig: () => GlobalConductorConfig;
  logger: ConductorLogger;
  onReload: (config: GlobalConductorConfig) => Promise<void>;
}): { close(): void } {
  let watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const closeWatchers = (): void => {
    for (const watcher of watchers) watcher.close();
    watchers = [];
  };

  const scheduleReload = (): void => {
    if (closed) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void reloadConfig();
    }, 250);
  };

  const installWatchers = (configToWatch: GlobalConductorConfig): void => {
    closeWatchers();
    for (const filePath of watchedConfigPaths(configToWatch)) {
      try {
        watchers.push(watch(filePath, scheduleReload));
      } catch (error) {
        input.logger.warn("Conductor hot reload watch skipped", {
          path: filePath,
          error: formatConfigError(error),
        });
      }
    }
    input.logger.debug("Conductor hot reload watches installed", {
      files: watchedConfigPaths(configToWatch),
    });
  };

  const reloadConfig = async (): Promise<void> => {
    if (closed) return;
    try {
      const nextConfig = await readGlobalConfig();
      await input.onReload(nextConfig);
    } catch (error) {
      input.logger.error("Conductor config reload failed", { error: formatConfigError(error) });
    } finally {
      installWatchers(input.getConfig());
    }
  };

  installWatchers(input.getConfig());
  return {
    close() {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      closeWatchers();
    },
  };
}

function watchedConfigPaths(config: GlobalConductorConfig): string[] {
  return [
    getDefaultConfigPath(),
    ...config.repositories.map((repo) => join(repo.repoPath, ".pi", "WORKFLOW.md")),
  ];
}

async function validateServeConfig(config: GlobalConductorConfig): Promise<void> {
  const errors = validateGlobalConfig(config);
  for (const repo of config.repositories) {
    try {
      await access(repo.repoPath);
      const workflow = await loadWorkflow(repo.repoPath);
      const resolved = resolveRepositoryConfig(
        repo,
        workflowConfigOverrides(workflow),
        {},
        getStateRoot(config),
      );
      validateBranchTemplate(resolved.branchTemplate);
      validateInitialPromptTemplate({ config: resolved, workflow });
    } catch (error) {
      errors.push(`${repo.owner}/${repo.repo}: ${formatConfigError(error)}`);
    }
  }
  if (config.webhook !== undefined) {
    try {
      await resolveWebhookSecret(config.webhook);
    } catch (error) {
      errors.push(`webhook secret unreadable: ${formatConfigError(error)}`);
    }
  }
  if (errors.length > 0) throw new Error(`Invalid conductor config:\n${errors.join("\n")}`);
}

function startPendingWebhookRecovery(
  orchestrator: ConductorOrchestrator,
  store: ConductorStore,
  logger: ConductorLogger,
): void {
  const startedAt = Date.now();
  logger.debug("Conductor webhook delivery recovery started");
  void processPendingWebhookDeliveries({
    store,
    orchestrator,
    logger,
    onError: (message) => {
      logger.warn(message.trim());
    },
  })
    .then(() => {
      logger.debug("Conductor webhook delivery recovery finished", {
        durationMs: Date.now() - startedAt,
      });
    })
    .catch((error: unknown) => {
      logger.error("Conductor webhook delivery recovery failed", {
        durationMs: Date.now() - startedAt,
        error: formatConfigError(error),
      });
    });
}

async function validateConfigCommand(stdout: Writable): Promise<void> {
  const config = await readGlobalConfig();
  const errors = validateGlobalConfig(config);
  try {
    await new GhGitHubClient().getAuthenticatedUser();
  } catch (error) {
    errors.push(`gh authentication failed: ${formatConfigError(error)}`);
  }
  for (const repo of config.repositories) {
    try {
      await access(repo.repoPath);
    } catch (error) {
      errors.push(`${repo.owner}/${repo.repo}: repoPath inaccessible: ${formatConfigError(error)}`);
    }
    try {
      const workflow = await loadWorkflow(repo.repoPath);
      const resolved = resolveRepositoryConfig(
        repo,
        workflowConfigOverrides(workflow),
        {},
        getStateRoot(config),
      );
      validateBranchTemplate(resolved.branchTemplate);
      validateInitialPromptTemplate({ config: resolved, workflow });
    } catch (error) {
      errors.push(`${repo.owner}/${repo.repo}: ${formatConfigError(error)}`);
    }
  }
  if (config.webhook !== undefined) {
    try {
      await resolveWebhookSecret(config.webhook);
    } catch (error) {
      errors.push(`webhook secret unreadable: ${formatConfigError(error)}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(
      [
        "Invalid conductor config:",
        ...errors,
        "",
        "Find GitHub Projects v2 owner/number with gh:",
        ...config.repositories.flatMap((repo) => [
          `  gh repo view ${repo.owner}/${repo.repo} --json projectsV2 --jq '.projectsV2.nodes[] | "owner=\\(.owner.login) number=\\(.number) title=\\(.title)"'`,
          `  gh project list --owner ${repo.owner}`,
        ]),
        "",
        "Then edit config.json and run `pi conductor config validate` again.",
      ].join("\n"),
    );
  }
  stdout.write("Conductor config valid.\n");
}

async function createStore(stateRoot: string): Promise<ConductorStore> {
  const store = new SqliteConductorStore(join(stateRoot, "state.sqlite"));
  await store.init();
  return store;
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const handler = (): void => {
      process.off("SIGINT", handler);
      process.off("SIGTERM", handler);
      resolve();
    };
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
  });
}
