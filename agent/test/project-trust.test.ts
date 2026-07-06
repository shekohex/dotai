import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { isDefaultTrustedProjectPath } from "../src/extensions/project-trust.js";
import { timedTest } from "./test-utils/timed-test.ts";
import { createTempDir } from "./test-utils/temp-paths.js";

timedTest("default project trust allows configured roots and descendants only", () => {
  expect(isDefaultTrustedProjectPath("/home/coder/project")).toBe(true);
  expect(isDefaultTrustedProjectPath("/home/coder/project/app")).toBe(true);
  expect(isDefaultTrustedProjectPath("/home/coder/dotai")).toBe(true);
  expect(isDefaultTrustedProjectPath("/home/coder/dotai/agent")).toBe(true);

  expect(isDefaultTrustedProjectPath("/home/coder/project-other")).toBe(false);
  expect(isDefaultTrustedProjectPath("/home/coder/dotai-other")).toBe(false);
  expect(isDefaultTrustedProjectPath("/home/coder")).toBe(false);
});

timedTest("default project trust allows conductor worktrees", async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await createTempDir("project-trust-agent-");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    expect(
      isDefaultTrustedProjectPath(join(agentDir, "conductor", "worktrees", "octo", "demo", "7")),
    ).toBe(true);
  } finally {
    restoreEnv("PI_CODING_AGENT_DIR", previousAgentDir);
  }
});

timedTest("default project trust allows configured conductor worktree roots", async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const tempDir = await createTempDir("project-trust-config-");
  const agentDir = join(tempDir, "agent");
  const stateRoot = join(tempDir, "state");
  const customWorktreeRoot = join(tempDir, "custom-worktrees");
  await mkdir(join(agentDir, "conductor"), { recursive: true });
  await writeFile(
    join(agentDir, "conductor", "config.json"),
    JSON.stringify({
      version: 1,
      stateRoot,
      repositories: [{ owner: "octo", repo: "demo", worktreeRoot: customWorktreeRoot }],
    }),
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    expect(isDefaultTrustedProjectPath(join(stateRoot, "worktrees", "octo", "demo", "7"))).toBe(
      true,
    );
    expect(isDefaultTrustedProjectPath(join(customWorktreeRoot, "7"))).toBe(true);
  } finally {
    restoreEnv("PI_CODING_AGENT_DIR", previousAgentDir);
  }
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
