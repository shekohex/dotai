import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Value } from "typebox/value";
import {
  GLANCE_DEFAULT_PORT,
  GLANCE_HEARTBEAT_INTERVAL_MS,
  GLANCE_NAME,
  GLANCE_PROBE_TIMEOUT_MS,
  GLANCE_SCHEMA_VERSION,
  GLANCE_STARTUP_TIMEOUT_MS,
} from "./constants.js";
import { getClientHeartbeatPath, getGlancePaths, type GlancePaths } from "./paths.js";
import {
  GlanceHeartbeatSchema,
  GlanceHealthSchema,
  GlanceStatusSchema,
  type GlanceStatus,
} from "./schemas.js";

export interface GlanceDaemonOptions {
  paths?: GlancePaths;
  port?: number;
  cwd?: string;
  startupTimeoutMs?: number;
}

export interface GlanceHeartbeatHandle {
  clientId: string;
  path: string;
  stop: () => Promise<void>;
}

export type GlanceStopResult = "stopped" | "not-running" | "unhealthy";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function readStatus(paths: GlancePaths): Promise<GlanceStatus | null> {
  try {
    const parsed = JSON.parse(await readFile(paths.statusPath, "utf8")) as unknown;
    return Value.Check(GlanceStatusSchema, parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function readGlanceStatus(
  paths: GlancePaths = getGlancePaths(),
): Promise<GlanceStatus | null> {
  return readStatus(paths);
}

export async function probeGlance(
  status: GlanceStatus,
  timeoutMs = GLANCE_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(`${status.baseUrl}/health`, { signal: controller.signal });
    if (!response.ok) {
      return false;
    }
    const body = (await response.json()) as unknown;
    return (
      Value.Check(GlanceHealthSchema, body) &&
      body.ok &&
      body.name === GLANCE_NAME &&
      body.schemaVersion === GLANCE_SCHEMA_VERSION &&
      body.port === status.port
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function probeHttpPort(port: number, timeoutMs = GLANCE_PROBE_TIMEOUT_MS): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function acquireStartupLock(paths: GlancePaths, startupTimeoutMs: number): Promise<boolean> {
  await mkdir(paths.runtimeDir, { recursive: true });
  try {
    await mkdir(paths.lockDir);
    return true;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
      throw error;
    }
    const lockStat = await stat(paths.lockDir).catch(() => null);
    const status = await readStatus(paths);
    if (status !== null && (await probeGlance(status))) {
      return false;
    }
    if (lockStat !== null && Date.now() - lockStat.mtimeMs > startupTimeoutMs) {
      await rm(paths.lockDir, { recursive: true, force: true });
      await mkdir(paths.lockDir);
      return true;
    }
    return false;
  }
}

async function releaseStartupLock(paths: GlancePaths): Promise<void> {
  await rm(paths.lockDir, { recursive: true, force: true });
}

function getDaemonEntryPath(): string {
  const currentDirectory = import.meta.dirname;
  const extension = import.meta.filename.endsWith(".ts") ? ".ts" : ".js";
  return join(currentDirectory, `daemon-entry${extension}`);
}

function spawnDaemon(options: GlanceDaemonOptions, paths: GlancePaths): void {
  const environment = {
    ...process.env,
    PI_GLANCE_PORT: String(options.port ?? GLANCE_DEFAULT_PORT),
    PI_GLANCE_AGENT_DIR: dirname(dirname(paths.runtimeDir)),
  };
  const entryPath = getDaemonEntryPath();
  const execArgs = entryPath.endsWith(".ts")
    ? ["--import", "tsx", entryPath]
    : [...process.execArgv, entryPath];
  const child = spawn(process.execPath, execArgs, {
    detached: true,
    stdio: "ignore",
    env: environment,
  });
  child.unref();
}

export async function ensureGlanceDaemon(options: GlanceDaemonOptions = {}): Promise<GlanceStatus> {
  const paths = options.paths ?? getGlancePaths();
  const startupTimeoutMs = options.startupTimeoutMs ?? GLANCE_STARTUP_TIMEOUT_MS;
  const existingStatus = await readStatus(paths);
  if (existingStatus !== null && (await probeGlance(existingStatus))) {
    return existingStatus;
  }

  const deadline = Date.now() + startupTimeoutMs;
  let ownsLock = await acquireStartupLock(paths, startupTimeoutMs);
  while (!ownsLock && Date.now() < deadline) {
    await sleep(200);
    const status = await readStatus(paths);
    if (status !== null && (await probeGlance(status))) {
      return status;
    }
    ownsLock = await acquireStartupLock(paths, startupTimeoutMs);
  }

  if (!ownsLock) {
    throw new Error(
      `Glance daemon startup timed out on port ${options.port ?? GLANCE_DEFAULT_PORT}`,
    );
  }

  try {
    const statusAfterLock = await readStatus(paths);
    if (statusAfterLock !== null && (await probeGlance(statusAfterLock))) {
      return statusAfterLock;
    }
    if (await probeHttpPort(options.port ?? GLANCE_DEFAULT_PORT)) {
      throw new Error(
        `Glance port ${options.port ?? GLANCE_DEFAULT_PORT} is occupied by a non-Glance server`,
      );
    }
    spawnDaemon(options, paths);
    while (Date.now() < deadline) {
      await sleep(200);
      const status = await readStatus(paths);
      if (status !== null && (await probeGlance(status))) {
        return status;
      }
    }
    throw new Error(`Glance daemon failed to start on port ${options.port ?? GLANCE_DEFAULT_PORT}`);
  } finally {
    await releaseStartupLock(paths);
  }
}

export async function startGlanceHeartbeat(
  options: GlanceDaemonOptions = {},
): Promise<GlanceHeartbeatHandle> {
  const paths = options.paths ?? getGlancePaths();
  await mkdir(paths.clientsDir, { recursive: true });
  const clientId = randomUUID();
  const path = getClientHeartbeatPath(paths, clientId);
  const startedAt = Date.now();
  let stopped = false;

  const writeHeartbeat = async (): Promise<void> => {
    const heartbeat = {
      schemaVersion: GLANCE_SCHEMA_VERSION,
      clientId,
      pid: process.pid,
      cwd: options.cwd ?? process.cwd(),
      startedAt,
      updatedAt: Date.now(),
    };
    if (!Value.Check(GlanceHeartbeatSchema, heartbeat)) {
      throw new Error("Invalid Glance heartbeat");
    }
    const tmpPath = `${path}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(heartbeat, null, 2)}\n`, { mode: 0o600 });
    await rename(tmpPath, path);
  };

  const writeHeartbeatIfRunning = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    await writeHeartbeat();
  };

  let pendingWrite = writeHeartbeatIfRunning();
  await pendingWrite;
  const timer = setInterval(() => {
    pendingWrite = pendingWrite.then(writeHeartbeatIfRunning, writeHeartbeatIfRunning);
    void pendingWrite.catch(() => {});
  }, GLANCE_HEARTBEAT_INTERVAL_MS);

  return {
    clientId,
    path,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await pendingWrite.catch(() => {});
      await rm(path, { force: true });
    },
  };
}

export async function stopGlanceDaemon(
  paths: GlancePaths = getGlancePaths(),
): Promise<GlanceStopResult> {
  const status = await readStatus(paths);
  if (status === null) {
    return "not-running";
  }
  if (!(await probeGlance(status))) {
    await rm(paths.statusPath, { force: true });
    return "unhealthy";
  }
  try {
    process.kill(status.pid, "SIGTERM");
  } catch {
    await rm(paths.statusPath, { force: true });
    return "not-running";
  }
  return "stopped";
}

export async function waitForGlanceStopped(
  paths: GlancePaths = getGlancePaths(),
  timeoutMs = GLANCE_STARTUP_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await readStatus(paths);
    if (status === null || !(await probeGlance(status))) {
      return true;
    }
    await sleep(100);
  }
  return false;
}

export async function cleanGlanceStorage(paths: GlancePaths = getGlancePaths()): Promise<number> {
  const entries = await readdir(paths.storageDir).catch(() => []);
  let deleted = 0;
  for (const entry of entries) {
    await rm(join(paths.storageDir, entry), { force: true });
    deleted++;
  }
  return deleted;
}
