import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrBackgroundShellBackend } from "../../src/extensions/coreui/background-bash-herdr-backend.js";
import { TmuxBackgroundShellBackend } from "../../src/extensions/coreui/background-bash-tmux-backend.js";
import type { BackgroundShellRun } from "../../src/extensions/coreui/background-bash-types.js";

let cwd: string;
let scriptPath: string;
let exitFile: string;
let outputFile: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "pi-background-bash-kill-"));
  scriptPath = join(cwd, "run.sh");
  exitFile = join(cwd, "run.exit");
  outputFile = join(cwd, "run.out");
  await writeFile(scriptPath, "#!/usr/bin/env bash\nsleep 30\n");
  await chmod(scriptPath, 0o700);
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function toRun(backend: "herdr" | "tmux", targetId: string): BackgroundShellRun {
  return {
    backend,
    command: "sleep 30",
    cwd,
    exitFile,
    id: "test-run",
    outputFile,
    startedAt: Date.now(),
    status: "running",
    targetId,
    targetLabel: `${backend} ${targetId}`,
  };
}

async function readExitFile(): Promise<string> {
  return (await readFile(exitFile, "utf-8")).trim();
}

describe("background shell kill exit-file synthesis", () => {
  test("tmux kill-window synthesizes missing exit file", async () => {
    const backend = new TmuxBackgroundShellBackend();
    const launch = await backend.launch({
      command: "sleep 30",
      cwd,
      description: "kill test",
      exitFile,
      id: "test-run",
      label: "kill-test",
      outputFile,
      scriptPath,
      startedAt: Date.now(),
    });

    await backend.kill(toRun("tmux", launch.targetId));
    expect(await readExitFile()).toBe("143");
  });

  test("tmux kill does not clobber an existing exit code", async () => {
    const backend = new TmuxBackgroundShellBackend();
    await writeFile(exitFile, "0\n");
    await backend.kill(toRun("tmux", "$1"));
    expect(await readExitFile()).toBe("0");
  });

  test("herdr closePane synthesizes missing exit file", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const backend = new HerdrBackgroundShellBackend(exec);

    await backend.kill(toRun("herdr", "pane-1"));
    expect(exec).toHaveBeenCalled();
    expect(await readExitFile()).toBe("143");
  });

  test("herdr kill of missing pane still synthesizes exit file", async () => {
    const exec = vi.fn(async () => {
      throw new Error("herdr pane not found: pane-1");
    });
    const backend = new HerdrBackgroundShellBackend(exec);

    await backend.kill(toRun("herdr", "pane-1"));
    expect(await readExitFile()).toBe("143");
  });

  test("herdr kill does not clobber an existing exit code", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const backend = new HerdrBackgroundShellBackend(exec);
    await writeFile(exitFile, "0\n");

    await backend.kill(toRun("herdr", "pane-1"));
    expect(await readExitFile()).toBe("0");
  });
});
