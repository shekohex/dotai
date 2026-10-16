import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Paseo's useAgent and useWorkspace throw outside a workspace panel, and our components render in
// the Conductors screen and sidebar too. Agent data comes from useAgentDirectory instead.
const PANEL_ONLY =
  /import\s*\{[^}]*\buse(?:Agent|Workspace)\b[^}]*\}\s*from\s*"@getpaseo\/plugin\/client"/;

async function sources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sources(full);
      return /\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")
        ? [full]
        : [];
    }),
  );
  return files.flat();
}

describe("client code", () => {
  it("never uses Paseo's panel-only state hooks", async () => {
    const root = path.resolve(import.meta.dirname, "..");
    const files = [
      ...(await sources(path.join(root, "client"))),
      path.join(root, "index.client.tsx"),
    ];
    const offenders = [];
    for (const file of files)
      if (PANEL_ONLY.test(await readFile(file, "utf8")))
        offenders.push(path.relative(root, file));
    expect(offenders).toEqual([]);
  });
});
