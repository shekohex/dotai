import { spawnSync } from "node:child_process";

export interface AuthToken {
  source: string;
  value: string;
}

export function resolveAuthToken(env: NodeJS.ProcessEnv = process.env): AuthToken | undefined {
  const envToken = resolveEnvToken(env);
  if (envToken) {
    return envToken;
  }

  const ghToken = spawnSync("gh", ["auth", "token"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const value = ghToken.status === 0 ? ghToken.stdout.trim() : "";
  return value ? { source: "gh auth token", value } : undefined;
}

export async function verifyGitHubPackagesAccess(
  token: AuthToken,
  endpoint: string,
): Promise<void> {
  const response = await fetch(endpoint, {
    headers: {
      authorization: `Bearer ${token.value}`,
      accept: "application/vnd.npm.install-v1+json",
    },
  });
  if (response.ok) {
    return;
  }

  const scopes = await fetchTokenScopes(token);
  if (scopes.length > 0 && !scopes.includes("read:packages")) {
    throw new Error(
      `token from ${token.source} missing read:packages scope. Run: gh auth refresh -s read:packages`,
    );
  }

  throw new Error(
    `GitHub Packages auth failed with ${token.source} (HTTP ${response.status}). Ensure token can read public packages and includes read:packages.`,
  );
}

function resolveEnvToken(env: NodeJS.ProcessEnv): AuthToken | undefined {
  const candidates: Array<[string, string | undefined]> = [
    ["NODE_AUTH_TOKEN", env.NODE_AUTH_TOKEN],
    ["NPM_TOKEN", env.NPM_TOKEN],
    ["GH_TOKEN", env.GH_TOKEN],
    ["GITHUB_TOKEN", env.GITHUB_TOKEN],
  ];
  const found = candidates.find(([, value]) => value !== undefined && value.trim().length > 0);
  if (found === undefined) {
    return undefined;
  }
  return { source: found[0], value: found[1]!.trim() };
}

async function fetchTokenScopes(token: AuthToken): Promise<string[]> {
  try {
    const response = await fetch("https://api.github.com/", {
      method: "HEAD",
      headers: {
        authorization: `Bearer ${token.value}`,
        accept: "application/vnd.github+json",
      },
    });
    const scopes = response.headers.get("x-oauth-scopes") ?? "";
    return scopes
      .split(",")
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0);
  } catch {
    return [];
  }
}
