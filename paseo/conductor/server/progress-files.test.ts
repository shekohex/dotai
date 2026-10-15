import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveConductorPaths } from "./paths.js";
import {
  previewFile,
  ProgressFileError,
  resolveTarget,
  RunHistory,
} from "./progress-files.js";

const tmp = () => mkdtemp(path.join(os.tmpdir(), "files-"));

describe("resolveTarget", () => {
  it("serves only recorded targets", () => {
    expect(() =>
      resolveTarget("/etc/passwd", new Set(["a.png"]), "/w"),
    ).toThrow(ProgressFileError);
    expect(resolveTarget("a.png", new Set(["a.png"]), "/w")).toEqual({
      kind: "file",
      filePath: "/w/a.png",
    });
    expect(
      resolveTarget("https://x.dev", new Set(["https://x.dev"]), null),
    ).toEqual({ kind: "link", url: "https://x.dev" });
  });
});

describe("previewFile", () => {
  it("previews images and text, and defers other files to the host", async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, "a.png"), Buffer.from([1, 2, 3]));
    await writeFile(path.join(dir, "n.md"), "# hi");
    await writeFile(path.join(dir, "v.mp4"), "x");
    expect(await previewFile(path.join(dir, "a.png"))).toMatchObject({
      kind: "image",
      mime: "image/png",
      data: "AQID",
    });
    expect(await previewFile(path.join(dir, "n.md"))).toEqual({
      kind: "text",
      text: "# hi",
      truncated: false,
    });
    expect((await previewFile(path.join(dir, "v.mp4"))).kind).toBe("open");
    expect((await previewFile(path.join(dir, "missing.png"))).kind).toBe(
      "open",
    );
  });
});

describe("RunHistory", () => {
  it("rejects folders outside the project and mirrors a run into one file", async () => {
    const root = await tmp();
    const workspace = await tmp();
    const history = new RunHistory(resolveConductorPaths(root));
    await expect(history.setFolder("c1", "../out")).rejects.toThrow(
      ProgressFileError,
    );
    await expect(history.setFolder("c1", "/abs")).rejects.toThrow(
      ProgressFileError,
    );
    await history.setFolder("c1", "docs/progress");
    expect(await history.folder("c1")).toBe("docs/progress");

    const run = [
      {
        v: 1 as const,
        ts: "2026-10-16T10:20:30.000Z",
        op: "start" as const,
        title: "Export Feature!",
      },
    ];
    await history.mirror("c1", workspace, run);
    const file = path.join(
      workspace,
      "docs/progress/history/20261016-102030-export-feature.jsonl",
    );
    expect(await readFile(file, "utf8")).toContain('"Export Feature!"');

    await history.setFolder("c1", null);
    expect(await history.folder("c1")).toBeNull();
  });
});
