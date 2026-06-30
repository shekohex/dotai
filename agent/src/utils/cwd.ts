/**
 * Defensive cwd expansion at the wrapper boundary.
 *
 * Upstream's `normalizePath` expands `~`/`~/` but NOT `$HOME`/`$VAR`, so a literal `$HOME/...`
 * reaching `resolvePath` is treated as relative and joined onto the real cwd — producing corrupt
 * session dirs like `.../raptors/$HOME/project/runraptors/raptors` that propagate on every resume.
 *
 * This helper expands shell-style `$VAR`/`${VAR}` and `~` at the wrapper entry points before
 * upstream sees the cwd, preventing new corruption. It does not repair pre-existing corrupt session
 * headers (those live in upstream's `SessionManager.open`).
 */

import { homedir } from "node:os";
import { resolve } from "node:path";

const ENV_VAR_PATTERN = /\$\{(?<name>[A-Za-z_][A-Za-z0-9_]*)\}|\$(?<bare>[A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Expand `~`, `~/.`, `$VAR`, and `${VAR}` in a path string. Returns the original string if no
 * expansion applies. Unknown `$VAR` is left as-is (matches shell behavior for unset vars only
 * loosely; we keep the literal so a misconfiguration surfaces rather than silently resolving to
 * empty).
 *
 * @param {string} input - Path string that may contain `~`/`$VAR`.
 * @returns {string} Expanded path string.
 */
export function expandCwd(input: string): string {
  let out = input.trim();

  // Tilde (mirrors upstream normalizePath).
  if (out === "~") return homedir();
  if (out.startsWith("~/") || (process.platform === "win32" && out.startsWith("~\\"))) {
    return resolve(homedir(), out.slice(2));
  }

  // $VAR / ${VAR}.
  if (out.includes("$")) {
    out = out.replace(
      ENV_VAR_PATTERN,
      (match, braced: string | undefined, bare: string | undefined) => {
        const name = braced ?? bare;
        if (name === undefined) return match;
        const value = process.env[name];
        return value !== undefined && value.length > 0 ? value : match;
      },
    );
  }

  return out;
}

/**
 * Expand and resolve a cwd for use as the agent working directory.
 *
 * @param {string | undefined} input - Raw cwd string (may contain `~`/`$VAR`). Defaults to process.cwd().
 * @returns {string} Resolved absolute path with `~`/`$VAR` expanded.
 */
export function resolveCwd(input: string | undefined): string {
  const raw = input ?? process.cwd();
  const expanded = expandCwd(raw);
  return resolve(expanded);
}
