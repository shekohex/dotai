import { execFile } from "node:child_process";

import type { Author } from "../shared/review.js";

const GH_TIMEOUT_MS = 8_000;
const CACHE_MS = 10 * 60_000;

let cached: { at: number; viewer: Author | null } | null = null;

function run(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: GH_TIMEOUT_MS, encoding: "utf8" }, (error, stdout) =>
      resolve(error ? null : stdout.trim()),
    );
  });
}

/** The GitHub login and avatar from `gh`, falling back to git's user name. Cached for ten minutes. */
export async function readViewer(): Promise<Author | null> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.viewer;
  let viewer: Author | null = null;
  const raw = await run("gh", ["api", "user", "--jq", "{login: .login, avatar_url: .avatar_url}"]);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { login?: string; avatar_url?: string };
      if (parsed.login) viewer = { login: parsed.login, avatarUrl: parsed.avatar_url ?? null };
    } catch {
      // Fall through to git's name.
    }
  }
  if (!viewer) {
    const name = await run("git", ["config", "user.name"]);
    if (name) viewer = { login: name, avatarUrl: null };
  }
  cached = { at: Date.now(), viewer };
  return viewer;
}
