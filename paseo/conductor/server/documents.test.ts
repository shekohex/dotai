import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { documentRefSchema } from "../shared/contracts.js";
import { DocumentConflictError, writeDocumentFile } from "./documents.js";
import { listMemoryFiles } from "./memory.js";

async function tempFile(content?: string): Promise<string> {
  const filePath = path.join(
    await mkdtemp(path.join(os.tmpdir(), "conductor-doc-")),
    "notes.md",
  );
  if (content !== undefined) await writeFile(filePath, content);
  return filePath;
}

describe("writeDocumentFile", () => {
  it("creates, updates, and deletes when the base content matches", async () => {
    const filePath = await tempFile();
    await writeDocumentFile({
      filePath,
      content: "a",
      previousContent: null,
      core: false,
    });
    await writeDocumentFile({
      filePath,
      content: "b",
      previousContent: "a",
      core: false,
    });
    expect(await readFile(filePath, "utf8")).toBe("b");
    await writeDocumentFile({
      filePath,
      content: null,
      previousContent: "b",
      core: false,
    });
    await expect(readFile(filePath, "utf8")).rejects.toThrow();
  });

  it("refuses to overwrite a file the conductor changed meanwhile", async () => {
    const filePath = await tempFile("conductor edit");
    await expect(
      writeDocumentFile({
        filePath,
        content: "mine",
        previousContent: "old",
        core: false,
      }),
    ).rejects.toBeInstanceOf(DocumentConflictError);
    expect(await readFile(filePath, "utf8")).toBe("conductor edit");
  });

  it("never deletes core files", async () => {
    const filePath = await tempFile("x");
    await expect(
      writeDocumentFile({
        filePath,
        content: null,
        previousContent: "x",
        core: true,
      }),
    ).rejects.toThrow("Clear its content");
  });
});

describe("documentRefSchema", () => {
  it("rejects path traversal in names and conductor ids", () => {
    expect(
      documentRefSchema.safeParse({ scope: "global", name: "../x.md" }).success,
    ).toBe(false);
    expect(
      documentRefSchema.safeParse({ scope: "global", name: "a/b.md" }).success,
    ).toBe(false);
    expect(
      documentRefSchema.safeParse({
        scope: "conductor",
        conductorId: "..",
        name: "notes.md",
      }).success,
    ).toBe(false);
    expect(
      documentRefSchema.safeParse({ scope: "global", name: "topic-1.md" })
        .success,
    ).toBe(true);
  });
});

describe("listMemoryFiles", () => {
  it("lists core files first, then other Markdown files alphabetically", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "conductor-list-"));
    for (const name of [
      "zeta.md",
      "notes.md",
      "alpha.md",
      "instructions.md",
      "skip.txt",
    ]) {
      await writeFile(path.join(directory, name), name);
    }
    const files = await listMemoryFiles(directory, {
      "instructions.md": "",
      "notes.md": "",
    });
    expect(files.map((file) => [file.name, file.core])).toEqual([
      ["instructions.md", true],
      ["notes.md", true],
      ["alpha.md", false],
      ["zeta.md", false],
    ]);
  });
});
