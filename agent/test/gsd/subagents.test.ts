import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
  awaitRoleResult,
  runRoleDetached,
  setGsdSubagentSdkFactoryForTests,
  spawnPlanner,
  spawnRole,
  spawnStructuredRole,
} from "../../src/extensions/gsd/subagents.js";

function createRoot(): string {
  return mkdtempSync(join(tmpdir(), "agent-gsd-subagents-"));
}

function createContext(cwd: string): ExtensionCommandContext {
  return {
    cwd,
    hasUI: false,
    ui: {
      notify: vi.fn(),
    },
    sessionManager: {
      getSessionId: () => "parent-session-id",
    },
  } as unknown as ExtensionCommandContext;
}

afterEach(() => {
  setGsdSubagentSdkFactoryForTests(undefined);
});

describe("gsd subagents", () => {
  it("spawnPlanner returns validated plan output", async () => {
    const spawn = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        structured: {
          plans: [
            {
              plan: "01",
              phase: "01",
              type: "implementation",
              wave: 1,
              depends_on: [],
              files_modified: ["src/index.ts"],
              autonomous: true,
              must_haves: ["works"],
            },
          ],
        },
      },
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);
    const result = await spawnPlanner({} as ExtensionAPI, createContext(createRoot()), "plan");
    expect(result.plans).toHaveLength(1);
    expect(spawn.mock.calls[0]?.[0]?.mode).toBe("gsd-planner");
    expect(spawn.mock.calls[0]?.[0]?.task).toBe("plan");
  });

  it("spawnStructuredRole validates arbitrary schema output", async () => {
    const spawn = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        structured: {
          answer: "ok",
        },
      },
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);
    const result = await spawnStructuredRole(
      {} as ExtensionAPI,
      createContext(createRoot()),
      "verifier",
      "verify",
      Type.Object({ answer: Type.String() }, { additionalProperties: false }),
      2,
    );
    expect(result).toEqual({ answer: "ok" });
    expect(spawn.mock.calls[0]?.[0]?.mode).toBe("gsd-verifier");
    expect(spawn.mock.calls[0]?.[0]?.task).toBe("verify");
  });

  it("spawnRole waits for completion", async () => {
    const waitForCompletion = vi.fn().mockResolvedValue({
      sessionId: "session-id",
      status: "completed",
      summary: "done",
    });
    const captureOutput = vi.fn().mockResolvedValue({ text: "captured output" });
    const spawn = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        handle: {
          waitForCompletion,
          captureOutput,
        },
      },
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);
    const result = await spawnRole(
      {} as ExtensionAPI,
      createContext(createRoot()),
      "executor",
      "execute",
    );
    expect(waitForCompletion).toHaveBeenCalledTimes(1);
    expect(captureOutput).toHaveBeenCalledWith(80);
    expect(spawn.mock.calls[0]?.[0]?.mode).toBe("gsd-executor");
    expect(spawn.mock.calls[0]?.[0]?.task).toBe("execute");
    expect(result).toEqual({
      sessionId: "session-id",
      summary: "done",
      capturedOutput: "captured output",
    });
  });

  it("spawnRole throws when child finishes with failed status", async () => {
    const waitForCompletion = vi.fn().mockResolvedValue({
      sessionId: "session-id",
      status: "failed",
      summary: "child crashed",
    });
    const captureOutput = vi.fn().mockResolvedValue({ text: "captured output" });
    const spawn = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        handle: {
          waitForCompletion,
          captureOutput,
        },
      },
    });

    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await expect(
      spawnRole({} as ExtensionAPI, createContext(createRoot()), "executor", "execute"),
    ).rejects.toThrow(/ended with status failed: child crashed/);
  });

  it("runRoleDetached returns session immediately and waits later", async () => {
    const waitForCompletion = vi.fn().mockResolvedValue({
      sessionId: "session-id",
      status: "completed",
      summary: "done",
    });
    const captureOutput = vi.fn().mockResolvedValue({ text: "captured output" });
    const spawn = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        handle: {
          sessionId: "session-id",
          waitForCompletion,
          captureOutput,
        },
      },
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);
    const result = await runRoleDetached(
      {} as ExtensionAPI,
      createContext(createRoot()),
      "executor",
      "execute",
    );
    expect(result.sessionId).toBe("session-id");
    expect(waitForCompletion).toHaveBeenCalledTimes(0);
    await expect(result.waitForResult()).resolves.toEqual({
      sessionId: "session-id",
      summary: "done",
      capturedOutput: "captured output",
    });
  });

  it("awaitRoleResult normalizes handle completion and capture", async () => {
    const handle = {
      waitForCompletion: vi.fn().mockResolvedValue({
        sessionId: "session-id",
        status: "completed",
        summary: "done",
      }),
      captureOutput: vi.fn().mockResolvedValue({ text: "captured output" }),
    };
    await expect(awaitRoleResult("executor", handle as never)).resolves.toEqual({
      sessionId: "session-id",
      summary: "done",
      capturedOutput: "captured output",
    });
  });
});
