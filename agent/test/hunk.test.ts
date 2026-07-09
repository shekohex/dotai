import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";

import { groupedExtensionsC } from "../src/extensions/definitions-group-c.js";
import hunkExtension from "../src/extensions/hunk.js";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
type ArgumentCompletions = (argumentPrefix: string) => unknown;

const originalHerdrEnv = process.env.HERDR_ENV;
const originalHerdrTabId = process.env.HERDR_TAB_ID;
const originalHerdrWorkspaceId = process.env.HERDR_WORKSPACE_ID;

function createHarness(exec: ExtensionAPI["exec"] = vi.fn()): {
  calls: ReturnType<typeof vi.fn>;
  notifications: string[];
  getArgumentCompletions(prefix: string): unknown;
  runCommand(args: string): Promise<void>;
} {
  let handler: CommandHandler | undefined;
  let argumentCompletions: ArgumentCompletions | undefined;
  const notifications: string[] = [];
  const calls = exec as ReturnType<typeof vi.fn>;
  const pi = {
    exec,
    registerCommand(name: string, definition: { handler: CommandHandler }) {
      if (name === "hunk") {
        handler = definition.handler;
        argumentCompletions = definition.getArgumentCompletions;
      }
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: "/repo",
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
    },
  } as ExtensionCommandContext;

  hunkExtension(pi);

  return {
    calls,
    notifications,
    getArgumentCompletions(prefix: string) {
      if (argumentCompletions === undefined) {
        throw new Error("hunk argument completions were not registered");
      }
      return argumentCompletions(prefix);
    },
    async runCommand(args: string) {
      if (handler === undefined) throw new Error("hunk command was not registered");
      await handler(args, ctx);
    },
  };
}

function execResult(code: number, stdout = "", stderr = "") {
  return { code, stdout, stderr } as Awaited<ReturnType<ExtensionAPI["exec"]>>;
}

afterEach(() => {
  if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
  else process.env.HERDR_ENV = originalHerdrEnv;
  if (originalHerdrTabId === undefined) delete process.env.HERDR_TAB_ID;
  else process.env.HERDR_TAB_ID = originalHerdrTabId;
  if (originalHerdrWorkspaceId === undefined) delete process.env.HERDR_WORKSPACE_ID;
  else process.env.HERDR_WORKSPACE_ID = originalHerdrWorkspaceId;
});

describe("hunk extension", () => {
  test("bundled definitions include hunk extension", () => {
    expect(groupedExtensionsC.some((definition) => definition.id === "hunk")).toBe(true);
  });

  test("completes staged review mode", () => {
    const harness = createHarness();

    expect(harness.getArgumentCompletions("sta")).toEqual([
      {
        value: "staged",
        label: "staged",
        description: "Review staged changes",
      },
    ]);
    expect(harness.getArgumentCompletions("other")).toBeNull();
  });

  test("requires Herdr", async () => {
    delete process.env.HERDR_ENV;
    const harness = createHarness();

    await harness.runCommand("");

    expect(harness.calls).not.toHaveBeenCalled();
    expect(harness.notifications).toEqual(["Hunk requires an active Herdr pane"]);
  });

  test("rejects command arguments", async () => {
    process.env.HERDR_ENV = "1";
    const harness = createHarness();

    await harness.runCommand("show HEAD");

    expect(harness.calls).not.toHaveBeenCalled();
    expect(harness.notifications).toEqual(["Usage: /hunk [staged]"]);
  });

  test("opens focused branch-labelled tab in watch mode", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_TAB_ID = "tab-1";
    process.env.HERDR_WORKSPACE_ID = "workspace-1";
    const exec = vi
      .fn()
      .mockResolvedValueOnce(execResult(0, "0.16.0\n"))
      .mockResolvedValueOnce(execResult(0, "feature/hunk-review\n"))
      .mockResolvedValueOnce(
        execResult(
          0,
          JSON.stringify({
            result: { tab: { tab_id: "tab-2" }, root_pane: { pane_id: "pane-2" } },
          }),
        ),
      )
      .mockResolvedValueOnce(execResult(0))
      .mockResolvedValueOnce(execResult(0));
    const harness = createHarness(exec);

    await harness.runCommand("");

    expect(exec).toHaveBeenNthCalledWith(1, "hunk", ["--version"], { cwd: "/repo" });
    expect(exec).toHaveBeenNthCalledWith(2, "git", ["branch", "--show-current"], {
      cwd: "/repo",
    });
    expect(exec).toHaveBeenNthCalledWith(
      3,
      "herdr",
      [
        "tab",
        "create",
        "--workspace",
        "workspace-1",
        "--cwd",
        "/repo",
        "--label",
        "Hunk: feature/hunk-review",
      ],
      { cwd: "/repo" },
    );
    expect(exec).toHaveBeenNthCalledWith(4, "herdr", ["tab", "focus", "tab-2"], { cwd: "/repo" });
    expect(exec).toHaveBeenNthCalledWith(
      5,
      "herdr",
      [
        "pane",
        "run",
        "pane-2",
        "{ hunk diff --watch --theme catppuccin-mocha --agent-notes --no-hunk-headers; }; __herdr_pane_status=$?; herdr tab focus 'tab-1'; herdr pane close 'pane-2'; exit $__herdr_pane_status",
      ],
      {
        cwd: "/repo",
      },
    );
    expect(harness.notifications).toEqual([]);
  });

  test("uses generic tab label outside a Git branch", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "workspace-1";
    const exec = vi
      .fn()
      .mockResolvedValueOnce(execResult(0, "0.16.0\n"))
      .mockResolvedValueOnce(execResult(1))
      .mockResolvedValueOnce(
        execResult(
          0,
          JSON.stringify({
            result: { tab: { tab_id: "tab-2" }, root_pane: { pane_id: "pane-2" } },
          }),
        ),
      )
      .mockResolvedValueOnce(execResult(0))
      .mockResolvedValueOnce(execResult(0));
    const harness = createHarness(exec);

    await harness.runCommand("");

    expect(exec).toHaveBeenNthCalledWith(3, "herdr", expect.arrayContaining(["--label", "Hunk"]), {
      cwd: "/repo",
    });
  });

  test("opens staged changes when requested", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_TAB_ID = "tab-1";
    process.env.HERDR_WORKSPACE_ID = "workspace-1";
    const exec = vi
      .fn()
      .mockResolvedValueOnce(execResult(0, "0.16.0\n"))
      .mockResolvedValueOnce(execResult(0, "feature/hunk-review\n"))
      .mockResolvedValueOnce(
        execResult(
          0,
          JSON.stringify({
            result: { tab: { tab_id: "tab-2" }, root_pane: { pane_id: "pane-2" } },
          }),
        ),
      )
      .mockResolvedValueOnce(execResult(0))
      .mockResolvedValueOnce(execResult(0));
    const harness = createHarness(exec);

    await harness.runCommand("staged");

    expect(exec).toHaveBeenNthCalledWith(
      5,
      "herdr",
      [
        "pane",
        "run",
        "pane-2",
        "{ hunk diff --watch --theme catppuccin-mocha --agent-notes --no-hunk-headers --staged; }; __herdr_pane_status=$?; herdr tab focus 'tab-1'; herdr pane close 'pane-2'; exit $__herdr_pane_status",
      ],
      { cwd: "/repo" },
    );
  });

  test("does not create a tab when Hunk is unavailable", async () => {
    process.env.HERDR_ENV = "1";
    const harness = createHarness(vi.fn().mockResolvedValue(execResult(127, "", "not found")));

    await harness.runCommand("");

    expect(harness.calls).toHaveBeenCalledTimes(1);
    expect(harness.notifications).toEqual([
      "Hunk unavailable: not found. Install with npm i -g hunkdiff",
    ]);
  });
});
