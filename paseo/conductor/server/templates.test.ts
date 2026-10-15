import { mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { TEMPLATES } from "./templates.generated.js";
import { installTemplates } from "./templates.js";

const source = path.join(import.meta.dirname, "..", "templates");

describe("page templates", () => {
  it("embeds exactly the files in templates/ (run npm run templates)", async () => {
    const names = (await readdir(source)).filter((name) =>
      name.endsWith(".html"),
    );
    expect(Object.keys(TEMPLATES).sort()).toEqual(names.sort());
    for (const name of names)
      expect(TEMPLATES[name], name).toBe(
        await readFile(path.join(source, name), "utf8"),
      );
  });

  it("are self-contained pages that follow the color scheme", () => {
    for (const [name, html] of Object.entries(TEMPLATES)) {
      expect(html, name).toMatch(/prefers-color-scheme:\s*dark/);
      expect(html, name).toContain('name="viewport"');
      expect(html, name).not.toMatch(/(src|href)="(https?:)?\/\//);
    }
  });

  it("installs them for agents to copy", async () => {
    const dir = path.join(await mkdtemp(path.join(os.tmpdir(), "tpl-")), "t");
    await installTemplates(dir);
    expect((await readdir(dir)).sort()).toEqual(Object.keys(TEMPLATES).sort());
  });
});
