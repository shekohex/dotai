import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadRuntimeIdentityFiles } from "./runtime-identity.js";

describe("loadRuntimeIdentityFiles", () => {
  it("loads exact Pi, Codex, and Paseo JSON without exposing contents", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "cube-identity-"));
    await Promise.all([
      mkdir(path.join(home, ".pi", "agent"), { recursive: true }),
      mkdir(path.join(home, ".codex"), { recursive: true }),
      mkdir(path.join(home, ".paseo"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        path.join(home, ".pi", "agent", "auth.json"),
        '{"pi":"secret"}\n',
      ),
      writeFile(path.join(home, ".codex", "auth.json"), '{"codex":"secret"}\n'),
      writeFile(path.join(home, ".paseo", "config.json"), '{"paseo":true}\n'),
    ]);

    await expect(loadRuntimeIdentityFiles(home)).resolves.toEqual([
      {
        destination: "/home/coder/.pi/agent/auth.json",
        contents: '{"pi":"secret"}\n',
      },
      {
        destination: "/home/coder/.codex/auth.json",
        contents: '{"codex":"secret"}\n',
      },
      {
        destination: "/home/coder/.paseo/config.json",
        contents: '{"paseo":true}\n',
      },
    ]);
  });

  it("reports invalid JSON without including secret contents", async () => {
    const home = await mkdtemp(
      path.join(os.tmpdir(), "cube-identity-invalid-"),
    );
    await mkdir(path.join(home, ".pi", "agent"), { recursive: true });
    await writeFile(
      path.join(home, ".pi", "agent", "auth.json"),
      "secret-not-json",
    );

    await expect(loadRuntimeIdentityFiles(home)).rejects.toThrow(
      "Pi auth file is not valid JSON",
    );
    await expect(loadRuntimeIdentityFiles(home)).rejects.not.toThrow(
      "secret-not-json",
    );
  });
});
