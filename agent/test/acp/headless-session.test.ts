import { rm } from "node:fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import { createRemoteSession, type RemoteSessionHandle } from "../../src/remote/session.js";
import { createTempDir } from "../test-utils/temp-paths.js";

const handles: RemoteSessionHandle[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) handle.dispose();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("shared headless sessions", () => {
  test("each session loads complete independent bundled catalogs", async () => {
    const firstDirectory = await createTempDir("acp-headless-first-");
    const secondDirectory = await createTempDir("acp-headless-second-");
    directories.push(firstDirectory, secondDirectory);
    const [first, second] = await Promise.all([
      createRemoteSession({ cwd: firstDirectory, agentDir: firstDirectory }),
      createRemoteSession({ cwd: secondDirectory, agentDir: secondDirectory }),
    ]);
    handles.push(first, second);

    const firstCommands = first.session.extensionRunner
      .getRegisteredCommands()
      .map((command) => command.invocationName)
      .toSorted();
    const secondCommands = second.session.extensionRunner
      .getRegisteredCommands()
      .map((command) => command.invocationName)
      .toSorted();
    const firstTools = first.session
      .getAllTools()
      .map((tool) => tool.name)
      .toSorted();
    const secondTools = second.session
      .getAllTools()
      .map((tool) => tool.name)
      .toSorted();

    expect(firstCommands).toEqual(secondCommands);
    expect(firstCommands).toEqual(expect.arrayContaining(["mode", "review", "goal", "subagents"]));
    expect(firstTools).toEqual(secondTools);
    expect(firstTools).toEqual(expect.arrayContaining(["subagent", "workflow", "apply_patch"]));
    expect(first.session.resourceLoader.getSkills().skills.length).toBeGreaterThan(0);
    expect(second.session.resourceLoader.getSkills().skills.length).toBeGreaterThan(0);

    first.dispose();
    handles.splice(handles.indexOf(first), 1);
    expect(second.session.extensionRunner.getRegisteredCommands().length).toBeGreaterThan(0);
  }, 30_000);
});
