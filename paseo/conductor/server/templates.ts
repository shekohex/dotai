import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { TEMPLATES } from "./templates.generated.js";

/** Writes the page templates where agents can copy them; refreshed on every start. */
export async function installTemplates(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await Promise.all(
    Object.entries(TEMPLATES).map(([name, html]) =>
      writeFile(path.join(dir, name), html),
    ),
  );
}
