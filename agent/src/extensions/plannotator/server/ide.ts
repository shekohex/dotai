/** IDE integration — open plan diffs in VS Code. Node.js equivalent of packages/server/ide.ts. */

import { spawn } from "node:child_process";

/**
 * Open two files in VS Code's diff viewer.
 *
 * @param {string} oldPath Old file path.
 * @param {string} newPath New file path.
 * @returns {{ ok: true } | { error: string }} Diff launch result.
 */
export function openEditorDiff(
  oldPath: string,
  newPath: string,
): Promise<{ ok: true } | { error: string }> {
  return new Promise((resolve) => {
    const proc = spawn("code", ["--diff", oldPath, newPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", (err) => {
      if (err.message.includes("ENOENT")) {
        resolve({
          error:
            "VS Code CLI not found. Run 'Shell Command: Install code command in PATH' from the VS Code command palette.",
        });
      } else {
        resolve({ error: err.message });
      }
    });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      if (stderr.includes("not found") || stderr.includes("ENOENT")) {
        resolve({
          error:
            "VS Code CLI not found. Run 'Shell Command: Install code command in PATH' from the VS Code command palette.",
        });
      } else {
        resolve({ error: `code --diff exited with ${code}: ${stderr}` });
      }
    });
  });
}
