import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { loadRuntimeIdentityBundle } from "./runtime-identity.js";

const execute = promisify(execFile);

async function run(command: string, args: string[], cwd?: string) {
  return execute(command, args, { cwd });
}

async function generateKeyPair(privateKeyPath: string): Promise<void> {
  await mkdir(path.dirname(privateKeyPath), { recursive: true });
  await run("ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-f",
    privateKeyPath,
  ]);
}

async function hostFixture() {
  const homeDirectory = await mkdtemp(
    path.join(os.tmpdir(), "cube-runtime-host-"),
  );
  const repositoryRoot = path.join(homeDirectory, "repository");
  const authKey = path.join(homeDirectory, ".ssh", "auth", "id_ed25519");
  const signingKey = path.join(
    homeDirectory,
    ".ssh",
    "git-commit-signing",
    "coder",
  );
  await Promise.all([
    mkdir(path.join(homeDirectory, ".pi", "agent"), { recursive: true }),
    mkdir(path.join(homeDirectory, ".codex"), { recursive: true }),
    mkdir(path.join(homeDirectory, ".paseo"), { recursive: true }),
    mkdir(repositoryRoot),
    generateKeyPair(authKey),
    generateKeyPair(signingKey),
  ]);
  await Promise.all([
    writeFile(
      path.join(homeDirectory, ".pi", "agent", "auth.json"),
      '{"pi":"fixture"}\n',
    ),
    writeFile(
      path.join(homeDirectory, ".codex", "auth.json"),
      '{"codex":"fixture"}\n',
    ),
    writeFile(
      path.join(homeDirectory, ".paseo", "config.json"),
      '{"paseo":true}\n',
    ),
  ]);
  const authPublic = await readFile(`${authKey}.pub`, "utf8");
  const publicFields = authPublic.trim().split(/\s+/).slice(0, 2).join(" ");
  await writeFile(
    path.join(homeDirectory, ".ssh", "known_hosts"),
    `github.com ${publicFields}\nexample.com ${publicFields}\n`,
  );
  await run("git", ["init", "-q"], repositoryRoot);
  for (const [key, value] of [
    ["user.name", "Runtime Fixture"],
    ["user.email", "runtime@example.test"],
    ["gpg.format", "ssh"],
    ["commit.gpgsign", "true"],
    ["user.signingkey", "~/.ssh/git-commit-signing/coder"],
  ] as const) {
    await run("git", ["config", key, value], repositoryRoot);
  }
  return {
    homeDirectory,
    repositoryRoot,
    authKey,
    environment: {
      CUBE_SSH_AUTH_KEY: "~/.ssh/auth/id_ed25519",
      CUBE_SSH_KNOWN_HOSTS_FILE: "~/.ssh/known_hosts",
    },
  };
}

describe("loadRuntimeIdentityBundle", () => {
  it("loads allowlisted runtime files, effective Git identity, and GitHub hosts", async () => {
    const fixture = await hostFixture();
    const bundle = await loadRuntimeIdentityBundle(fixture.repositoryRoot, {
      homeDirectory: fixture.homeDirectory,
      environment: fixture.environment,
    });

    expect(bundle.git).toEqual({
      userName: "Runtime Fixture",
      userEmail: "runtime@example.test",
      authKeyPath: "/home/coder/.ssh/auth/id_ed25519",
      signingKeyPath: "/home/coder/.ssh/git-commit-signing/coder",
      knownHostsPath: "/home/coder/.ssh/known_hosts",
    });
    expect(
      bundle.files.map(({ destination, mode }) => [destination, mode]),
    ).toEqual([
      ["/home/coder/.pi/agent/auth.json", 0o600],
      ["/home/coder/.codex/auth.json", 0o600],
      ["/home/coder/.paseo/config.json", 0o600],
      ["/home/coder/.ssh/auth/id_ed25519", 0o600],
      ["/home/coder/.ssh/auth/id_ed25519.pub", 0o644],
      ["/home/coder/.ssh/git-commit-signing/coder", 0o600],
      ["/home/coder/.ssh/git-commit-signing/coder.pub", 0o644],
      ["/home/coder/.ssh/known_hosts", 0o600],
    ]);
    const knownHosts = bundle.files.find(({ destination }) =>
      destination.endsWith("known_hosts"),
    );
    expect(knownHosts?.contents).toContain("github.com ");
    expect(knownHosts?.contents).not.toContain("example.com");
  });

  it("creates and verifies an SSH-signed commit with the transferred pair", async () => {
    const fixture = await hostFixture();
    const bundle = await loadRuntimeIdentityBundle(fixture.repositoryRoot, {
      homeDirectory: fixture.homeDirectory,
      environment: fixture.environment,
    });
    const sandboxHome = path.join(fixture.homeDirectory, "sandbox-home");
    for (const file of bundle.files) {
      if (!file.destination.startsWith("/home/coder/")) continue;
      const target = path.join(
        sandboxHome,
        file.destination.slice("/home/coder/".length),
      );
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.contents, { mode: file.mode });
      await chmod(target, file.mode);
    }
    const signingKey = path.join(
      sandboxHome,
      ".ssh",
      "git-commit-signing",
      "coder",
    );
    const signedRepository = path.join(fixture.homeDirectory, "signed-repo");
    await mkdir(signedRepository);
    await run("git", ["init", "-q"], signedRepository);
    await run(
      "git",
      ["config", "user.name", bundle.git.userName],
      signedRepository,
    );
    await run(
      "git",
      ["config", "user.email", bundle.git.userEmail],
      signedRepository,
    );
    await run("git", ["config", "gpg.format", "ssh"], signedRepository);
    await run("git", ["config", "commit.gpgsign", "true"], signedRepository);
    await run(
      "git",
      ["config", "user.signingkey", signingKey],
      signedRepository,
    );
    await writeFile(path.join(signedRepository, "fixture.txt"), "signed\n");
    await run("git", ["add", "fixture.txt"], signedRepository);
    await run("git", ["commit", "-qm", "signed fixture"], signedRepository);
    const commit = await run(
      "git",
      ["cat-file", "commit", "HEAD"],
      signedRepository,
    );
    expect(commit.stdout).toContain("gpgsig -----BEGIN SSH SIGNATURE-----");

    const signingPublic = await readFile(`${signingKey}.pub`, "utf8");
    const allowedSigners = path.join(fixture.homeDirectory, "allowed-signers");
    await writeFile(
      allowedSigners,
      `${bundle.git.userEmail} ${signingPublic.trim()}\n`,
    );
    await run(
      "git",
      [
        "-c",
        `gpg.ssh.allowedSignersFile=${allowedSigners}`,
        "verify-commit",
        "HEAD",
      ],
      signedRepository,
    );
  });

  it.each([
    ["relative traversal", "~/.ssh/../outside"],
    ["outside SSH allowlist", "/tmp/outside-cube-key"],
  ])("rejects %s", async (_label, configuredPath) => {
    const fixture = await hostFixture();
    await expect(
      loadRuntimeIdentityBundle(fixture.repositoryRoot, {
        homeDirectory: fixture.homeDirectory,
        environment: {
          ...fixture.environment,
          CUBE_SSH_AUTH_KEY: configuredPath,
        },
      }),
    ).rejects.toThrow(/inside .*\.ssh|path traversal/);
  });

  it("rejects symlinked key sources", async () => {
    const fixture = await hostFixture();
    const symlinkPath = path.join(fixture.homeDirectory, ".ssh", "linked-key");
    await symlink(fixture.authKey, symlinkPath);
    await symlink(`${fixture.authKey}.pub`, `${symlinkPath}.pub`);

    await expect(
      loadRuntimeIdentityBundle(fixture.repositoryRoot, {
        homeDirectory: fixture.homeDirectory,
        environment: {
          ...fixture.environment,
          CUBE_SSH_AUTH_KEY: "~/.ssh/linked-key",
        },
      }),
    ).rejects.toThrow("must not be a symbolic link");
  });

  it.each(["authorized_keys", "known_hosts.old"])(
    "rejects disallowed SSH source %s",
    async (sourceName) => {
      const fixture = await hostFixture();
      await expect(
        loadRuntimeIdentityBundle(fixture.repositoryRoot, {
          homeDirectory: fixture.homeDirectory,
          environment: {
            ...fixture.environment,
            CUBE_SSH_AUTH_KEY: `~/.ssh/${sourceName}`,
          },
        }),
      ).rejects.toThrow("must not use disallowed SSH file");
    },
  );

  it("rejects a symlinked SSH directory", async () => {
    const fixture = await hostFixture();
    const sshDirectory = path.join(fixture.homeDirectory, ".ssh");
    const realSshDirectory = path.join(fixture.homeDirectory, ".ssh-real");
    await rename(sshDirectory, realSshDirectory);
    await symlink(realSshDirectory, sshDirectory);

    await expect(
      loadRuntimeIdentityBundle(fixture.repositoryRoot, {
        homeDirectory: fixture.homeDirectory,
        environment: fixture.environment,
      }),
    ).rejects.toThrow("SSH directory must not be a symbolic link");
  });

  it("rejects private keys readable by group or other users", async () => {
    const fixture = await hostFixture();
    await chmod(fixture.authKey, 0o644);

    await expect(
      loadRuntimeIdentityBundle(fixture.repositoryRoot, {
        homeDirectory: fixture.homeDirectory,
        environment: fixture.environment,
      }),
    ).rejects.toThrow("permissions must not grant group or other access");
  });

  it("reports missing explicit keys without exposing other key bytes", async () => {
    const fixture = await hostFixture();
    const privateDigest = createHash("sha256")
      .update(await readFile(fixture.authKey))
      .digest("hex");
    let message = "";
    try {
      await loadRuntimeIdentityBundle(fixture.repositoryRoot, {
        homeDirectory: fixture.homeDirectory,
        environment: {
          ...fixture.environment,
          CUBE_SSH_AUTH_KEY: "~/.ssh/missing",
        },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("SSH auth private key does not exist");
    expect(message).not.toContain(privateDigest);
  });

  it("reports invalid JSON without including secret contents", async () => {
    const fixture = await hostFixture();
    await writeFile(
      path.join(fixture.homeDirectory, ".codex", "auth.json"),
      "secret-not-json",
    );

    await expect(
      loadRuntimeIdentityBundle(fixture.repositoryRoot, {
        homeDirectory: fixture.homeDirectory,
        environment: fixture.environment,
      }),
    ).rejects.toThrow("Codex auth file is not valid JSON");
    await expect(
      loadRuntimeIdentityBundle(fixture.repositoryRoot, {
        homeDirectory: fixture.homeDirectory,
        environment: fixture.environment,
      }),
    ).rejects.not.toThrow("secret-not-json");
  });
});
