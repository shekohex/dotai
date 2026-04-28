import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { getModeSpec, hasText } from "../src/extensions/modes/core.ts";
import { ensureRuntime } from "../src/extensions/modes/runtime.ts";
import {
  clearRemoteModesSnapshot,
  setRemoteModesSnapshot,
} from "../src/remote/client/remote-modes-store.ts";

test("modes runtime prefers remote snapshot over filesystem on client", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-modes-remote-"));
  const sessionId = "remote-session";

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

    setRemoteModesSnapshot(sessionId, {
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
        sessionManager: {
          getSessionId: () => sessionId,
        },
      } as never,
      { hasText, getModeSpec },
    );

    expect(runtime.source).toBe("remote");
    expect(runtime.data.currentMode).toBe("remote");
    expect(runtime.data.modes.remote?.provider).toBe("remote-provider");
    expect(runtime.activeMode).toBe("remote");
  } finally {
    clearRemoteModesSnapshot(sessionId);
    await rm(cwd, { recursive: true, force: true });
  }
});
