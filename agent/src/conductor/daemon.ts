import { spawn } from "node:child_process";
import { open, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { parseJsonValue } from "./json.js";

export type ConductorDaemonPaths = {
  dir: string;
  pidPath: string;
  logPath: string;
  errorLogPath: string;
};

export type ConductorDaemonStatus = ConductorDaemonPaths & {
  running: boolean;
  pid?: number;
};

const ConductorPidFileSchema = Type.Object({
  pid: Type.Number({ minimum: 1 }),
  entrypoint: Type.Optional(Type.String()),
  createdAt: Type.Optional(Type.String()),
});

type ConductorPidFile = Static<typeof ConductorPidFileSchema>;

export function conductorDaemonPaths(stateRoot: string): ConductorDaemonPaths {
  const dir = join(stateRoot, "daemon");
  return {
    dir,
    pidPath: join(dir, "conductor.pid"),
    logPath: join(dir, "conductor.log"),
    errorLogPath: join(dir, "conductor.err.log"),
  };
}

export async function readConductorDaemonStatus(stateRoot: string): Promise<ConductorDaemonStatus> {
  const paths = conductorDaemonPaths(stateRoot);
  const pidFile = await readPidFile(paths.pidPath);
  if (pidFile === undefined || !(await isConductorDaemonProcess(pidFile))) {
    return { ...paths, running: false };
  }
  return { ...paths, running: true, pid: pidFile.pid };
}

export async function startConductorDaemon(input: {
  stateRoot: string;
  cwd: string;
}): Promise<ConductorDaemonStatus & { started: boolean }> {
  const current = await readConductorDaemonStatus(input.stateRoot);
  if (current.running) return { ...current, started: false };
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) throw new Error("Cannot determine pi entrypoint for daemon start");
  await mkdir(current.dir, { recursive: true });
  const stdout = await open(current.logPath, "a");
  const stderr = await open(current.errorLogPath, "a");
  try {
    const child = spawn(process.execPath, [entrypoint, "conductor", "serve"], {
      cwd: input.cwd,
      detached: true,
      env: { ...process.env, PI_CONDUCTOR_DAEMON: "1" },
      stdio: ["ignore", stdout.fd, stderr.fd],
    });
    if (child.pid === undefined) throw new Error("Failed to start conductor daemon");
    await writeFile(
      current.pidPath,
      `${JSON.stringify({ pid: child.pid, entrypoint, createdAt: new Date().toISOString() })}\n`,
      "utf8",
    );
    child.unref();
    return { ...current, running: true, pid: child.pid, started: true };
  } finally {
    await stdout.close();
    await stderr.close();
  }
}

export async function stopConductorDaemon(
  stateRoot: string,
): Promise<ConductorDaemonStatus & { stopped: boolean }> {
  const current = await readConductorDaemonStatus(stateRoot);
  if (!current.running || current.pid === undefined) {
    await rm(current.pidPath, { force: true });
    return { ...current, stopped: false };
  }
  process.kill(current.pid, "SIGTERM");
  const stopped = await waitForProcessExit(current.pid, 5000);
  if (stopped) await rm(current.pidPath, { force: true });
  return { ...current, running: !stopped, stopped };
}

async function readPidFile(pidPath: string): Promise<ConductorPidFile | undefined> {
  try {
    const text = (await readFile(pidPath, "utf8")).trim();
    const numeric = Number(text);
    if (Number.isInteger(numeric) && numeric > 0) return { pid: numeric };
    try {
      return Value.Parse(ConductorPidFileSchema, parseJsonValue(text, "conductor pid file"));
    } catch {
      return undefined;
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function isConductorDaemonProcess(pidFile: ConductorPidFile): Promise<boolean> {
  if (!isProcessRunning(pidFile.pid)) return false;
  const commandLine = await readProcessCommandLine(pidFile.pid);
  if (commandLine === undefined) return true;
  if (!commandLine.includes("conductor") || !commandLine.includes("serve")) return false;
  return pidFile.entrypoint === undefined || commandLine.includes(pidFile.entrypoint);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return true;
    await delay(50);
  }
  return false;
}

async function readProcessCommandLine(pid: number): Promise<string | undefined> {
  try {
    return (await readFile(`/proc/${pid}/cmdline`, "utf8")).replaceAll("\0", " ");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
