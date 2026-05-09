import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createWriteToolOverrideDefinition } from "../src/extensions/coreui/tools.ts";

const TEST_TIMEOUT_MS = 15_000;

const timedTest: typeof test = ((name: string, fn: (...args: any[]) => any) =>
  test(name, { timeout: TEST_TIMEOUT_MS }, fn)) as typeof test;

timedTest("write tool execute resolves relative paths from context cwd", async () => {
  const originalCwd = process.cwd();
  const rootDir = await mkdtemp(join(tmpdir(), "agent-coreui-builtins-root-"));
  const workspaceDir = await mkdtemp(join(rootDir, "workspace-"));
  const serverDir = await mkdtemp(join(rootDir, "server-"));
  const tool = createWriteToolOverrideDefinition();

  try {
    process.chdir(serverDir);

    await tool.execute?.(
      "tool-call-write-cwd",
      { path: "note.txt", content: "hello workspace" },
      undefined,
      undefined,
      { cwd: workspaceDir } as ExtensionContext,
    );

    const written = await readFile(join(workspaceDir, "note.txt"), "utf8");
    expect(written).toBe("hello workspace");

    await expect(access(join(serverDir, "note.txt"))).rejects.toThrow();
  } finally {
    process.chdir(originalCwd);
    await rm(rootDir, { recursive: true, force: true });
  }
});
