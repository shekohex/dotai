import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { getModeSpec, hasText } from "../src/extensions/modes/core.ts";
import { ensureRuntime, saveRuntime } from "../src/extensions/modes/runtime.ts";
import {
  resolveContextModeSpec,
  resolveSessionLaunchOptions,
} from "../src/extensions/session-launch-utils.ts";
import { setModelRemoteSession } from "../src/remote/client/session-state-ops.ts";
import {
  getRemoteModesSnapshot,
  clearRemoteModesSnapshot,
  setRemoteModesSnapshot,
} from "../src/remote/client/remote-modes-store.ts";

test("modes runtime prefers remote snapshot over filesystem on client", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-modes-remote-"));
  const sessionId = "remote-session";
  const sessionManager = {
    getSessionId: () => sessionId,
  };

  try {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "modes.json"),
      JSON.stringify({
        version: 1,
        currentMode: "local",
        modes: {
          local: {
            provider: "local-provider",
            modelId: "local-model",
            thinkingLevel: "low",
          },
        },
      }),
    );

    setRemoteModesSnapshot(sessionManager, {
      version: 1,
      currentMode: "remote",
      modes: {
        remote: {
          provider: "remote-provider",
          modelId: "remote-model",
          thinkingLevel: "high",
        },
      },
    });

    const runtime = {
      path: "",
      source: "missing" as const,
      data: { version: 1, currentMode: undefined, modes: {} },
      activeMode: undefined,
      error: undefined,
      lastReportedError: undefined,
    };

    await ensureRuntime(
      runtime,
      {
        cwd,
        sessionManager,
      } as never,
      { hasText, getModeSpec },
    );

    expect(runtime.source).toBe("remote");
    expect(runtime.data.currentMode).toBe("remote");
    expect(runtime.data.modes.remote?.provider).toBe("remote-provider");
    expect(runtime.activeMode).toBe("remote");
  } finally {
    clearRemoteModesSnapshot(sessionManager);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("session launch resolves mode from remote snapshot before filesystem", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-modes-launch-"));
  const sessionId = "launch-session";
  const sessionManager = {
    getSessionId: () => sessionId,
  };

  try {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "modes.json"),
      JSON.stringify({
        version: 1,
        currentMode: "local",
        modes: {
          docs: {
            provider: "local-provider",
            modelId: "local-model",
            thinkingLevel: "low",
          },
        },
      }),
    );

    const remoteModel = {
      provider: "remote-provider",
      id: "remote-model",
    };

    setRemoteModesSnapshot(sessionManager, {
      version: 1,
      currentMode: "docs",
      modes: {
        docs: {
          provider: remoteModel.provider,
          modelId: remoteModel.id,
          thinkingLevel: "high",
        },
      },
    });

    const modeSpec = await resolveContextModeSpec(
      {
        cwd,
        sessionManager,
      } as never,
      "docs",
    );

    expect(modeSpec?.provider).toBe("remote-provider");
    expect(modeSpec?.thinkingLevel).toBe("high");

    const resolved = await resolveSessionLaunchOptions(
      {
        cwd,
        sessionManager,
        modelRegistry: {
          find: (provider: string, modelId: string) =>
            provider === remoteModel.provider && modelId === remoteModel.id
              ? remoteModel
              : undefined,
        },
      } as never,
      { mode: "docs" },
    );

    expect(resolved.error).toBe(undefined);
    expect(resolved.overrides?.thinkingLevel).toBe("high");
    expect(resolved.overrides?.targetModel).toBe(remoteModel);
  } finally {
    clearRemoteModesSnapshot(sessionManager);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("remote setModel preserves thinking level in updateModel request", async () => {
  const calls: Array<{ model: string; thinkingLevel?: string }> = [];
  const model = {
    provider: "demo-provider",
    id: "demo-model",
  };

  await setModelRemoteSession({
    client: {
      updateModel: async (_sessionId: string, body: { model: string; thinkingLevel?: string }) => {
        calls.push(body);
      },
    } as never,
    sessionId: "session-1",
    model: model as never,
    thinkingLevel: "high",
    setModelState: () => {},
    setDefaultModel: () => {},
    setDefaultThinkingLevel: () => {},
  });

  expect(calls).toEqual([{ model: "demo-provider/demo-model", thinkingLevel: "high" }]);
});

test("saving remote modes updates in-memory snapshot without touching filesystem", async () => {
  const sessionId = "remote-save-session";
  const missingCwd = join(tmpdir(), "pi-modes-missing-parent", `${Date.now()}`);
  const sessionManager = {
    getSessionId: () => sessionId,
  };

  try {
    setRemoteModesSnapshot(sessionManager, {
      version: 1,
      currentMode: "docs",
      modes: {
        docs: {
          provider: "remote-provider",
          modelId: "remote-model",
          thinkingLevel: "medium",
        },
      },
    });

    const runtime = {
      path: "",
      source: "missing" as const,
      data: { version: 1, currentMode: undefined, modes: {} },
      activeMode: undefined,
      error: undefined,
      lastReportedError: undefined,
    };

    const ctx = {
      cwd: join(missingCwd, "project"),
      sessionManager,
    } as never;

    await ensureRuntime(runtime, ctx, { hasText, getModeSpec });
    runtime.data.currentMode = "review";
    runtime.data.modes.review = {
      provider: "remote-provider",
      modelId: "remote-model",
      thinkingLevel: "high",
    };

    await expect(saveRuntime(runtime, ctx)).resolves.toBeUndefined();

    expect(getRemoteModesSnapshot(sessionManager)).toEqual({
      version: 1,
      currentMode: "review",
      modes: {
        docs: {
          provider: "remote-provider",
          modelId: "remote-model",
          thinkingLevel: "medium",
        },
        review: {
          provider: "remote-provider",
          modelId: "remote-model",
          thinkingLevel: "high",
        },
      },
    });
  } finally {
    clearRemoteModesSnapshot(sessionManager);
  }
});
