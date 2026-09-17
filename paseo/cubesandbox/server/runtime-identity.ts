import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

const executeFile = promisify(execFile);
const jsonObjectSchema = z.record(z.string(), z.unknown());
const nonEmptyStringSchema = z.string().trim().min(1);
const sandboxHome = "/home/coder";
const githubAuthTokenArguments = ["auth", "token"] as const;

export interface RuntimeIdentityFile {
  destination: string;
  contents: string;
  mode: 0o600 | 0o644;
}

export interface RuntimeGitIdentity {
  userName: string;
  userEmail: string;
  authKeyPath: string;
  signingKeyPath: string;
  knownHostsPath?: string;
}

export interface RuntimeIdentityBundle {
  files: RuntimeIdentityFile[];
  git: RuntimeGitIdentity;
  githubToken?: string;
}

interface LoadRuntimeIdentityOptions {
  homeDirectory?: string;
  environment?: NodeJS.ProcessEnv;
}

interface IdentityFileSpec {
  label: string;
  source: string[];
  destination: string;
}

async function resolveGithubToken(
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN"] as const) {
    const token = environment[name]?.trim();
    if (token) return token;
  }
  try {
    const cliEnvironment: NodeJS.ProcessEnv = {
      PATH: environment.PATH ?? process.env.PATH,
      HOME: environment.HOME ?? os.homedir(),
      ...(environment.GH_CONFIG_DIR
        ? { GH_CONFIG_DIR: environment.GH_CONFIG_DIR }
        : {}),
      ...(environment.XDG_CONFIG_HOME
        ? { XDG_CONFIG_HOME: environment.XDG_CONFIG_HOME }
        : {}),
    };
    const { stdout } = await executeFile("gh", githubAuthTokenArguments, {
      // gh has no timeout flag; bound the child process here.
      env: cliEnvironment,
      timeout: 5_000,
      killSignal: "SIGTERM",
      maxBuffer: 64 * 1024,
    });
    const token = stdout.trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

const identityFileSpecs: IdentityFileSpec[] = [
  {
    label: "Pi auth",
    source: [".pi", "agent", "auth.json"],
    destination: "/home/coder/.pi/agent/auth.json",
  },
  {
    label: "Codex auth",
    source: [".codex", "auth.json"],
    destination: "/home/coder/.codex/auth.json",
  },
  {
    label: "Paseo config",
    source: [".paseo", "config.json"],
    destination: "/home/coder/.paseo/config.json",
  },
];

async function loadJsonIdentityFile(
  homeDirectory: string,
  spec: IdentityFileSpec,
): Promise<RuntimeIdentityFile> {
  const sourcePath = path.join(homeDirectory, ...spec.source);
  let contents: string;
  try {
    contents = await readFile(sourcePath, "utf8");
  } catch (error) {
    throw new Error(`${spec.label} file does not exist: ${sourcePath}`, {
      cause: error,
    });
  }
  try {
    jsonObjectSchema.parse(JSON.parse(contents) as unknown);
  } catch (error) {
    throw new Error(`${spec.label} file is not valid JSON: ${sourcePath}`, {
      cause: error,
    });
  }
  return { destination: spec.destination, contents, mode: 0o600 };
}

function expandConfiguredPath(
  configuredPath: string,
  homeDirectory: string,
  label: string,
): string {
  if (configuredPath.split(/[\\/]/).includes("..")) {
    throw new Error(`${label} must not contain path traversal`);
  }
  if (configuredPath === "~") return homeDirectory;
  if (configuredPath.startsWith("~/")) {
    return path.join(homeDirectory, configuredPath.slice(2));
  }
  if (path.isAbsolute(configuredPath)) return path.normalize(configuredPath);
  throw new Error(`${label} must use an absolute path or ~/ prefix`);
}

async function readAllowlistedSshFile(
  configuredPath: string,
  homeDirectory: string,
  label: string,
): Promise<{ sourcePath: string; relativePath: string; contents: string }> {
  const sshDirectory = path.join(homeDirectory, ".ssh");
  const sourcePath = expandConfiguredPath(configuredPath, homeDirectory, label);
  let sshDirectoryMetadata;
  try {
    sshDirectoryMetadata = await lstat(sshDirectory);
  } catch (error) {
    throw new Error(`SSH directory does not exist: ${sshDirectory}`, {
      cause: error,
    });
  }
  if (sshDirectoryMetadata.isSymbolicLink()) {
    throw new Error(
      `SSH directory must not be a symbolic link: ${sshDirectory}`,
    );
  }
  if (!sshDirectoryMetadata.isDirectory()) {
    throw new Error(`SSH directory must be a directory: ${sshDirectory}`);
  }
  const relativePath = path.relative(sshDirectory, sourcePath);
  if (
    !relativePath ||
    relativePath.startsWith(`..${path.sep}`) ||
    relativePath === ".." ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(`${label} must be inside ${sshDirectory}`);
  }
  const sourceName = path.basename(relativePath);
  if (sourceName === "authorized_keys" || sourceName === "known_hosts.old") {
    throw new Error(`${label} must not use disallowed SSH file ${sourceName}`);
  }

  let currentPath = sshDirectory;
  for (const segment of relativePath.split(path.sep)) {
    currentPath = path.join(currentPath, segment);
    let metadata;
    try {
      metadata = await lstat(currentPath);
    } catch (error) {
      throw new Error(`${label} does not exist: ${sourcePath}`, {
        cause: error,
      });
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(`${label} must not be a symbolic link: ${currentPath}`);
    }
  }
  const metadata = await lstat(sourcePath);
  if (!metadata.isFile()) throw new Error(`${label} must be a regular file`);
  return {
    sourcePath,
    relativePath: relativePath.split(path.sep).join("/"),
    contents: await readFile(sourcePath, "utf8"),
  };
}

async function loadSshKeyPair(
  configuredPrivateKey: string,
  homeDirectory: string,
  label: string,
): Promise<RuntimeIdentityFile[]> {
  const privateKey = await readAllowlistedSshFile(
    configuredPrivateKey,
    homeDirectory,
    `${label} private key`,
  );
  const publicKey = await readAllowlistedSshFile(
    `${configuredPrivateKey}.pub`,
    homeDirectory,
    `${label} public key`,
  );
  const privateMode = (await lstat(privateKey.sourcePath)).mode & 0o777;
  if ((privateMode & 0o077) !== 0) {
    throw new Error(
      `${label} private key permissions must not grant group or other access`,
    );
  }
  if (!privateKey.contents.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----")) {
    throw new Error(`${label} private key must use OpenSSH private-key format`);
  }
  const publicFields = publicKey.contents.trim().split(/\s+/).slice(0, 2);
  if (publicFields.length !== 2 || !publicFields[0]?.startsWith("ssh-")) {
    throw new Error(`${label} public key is invalid`);
  }
  let derivedPublicKey: string;
  try {
    derivedPublicKey = (
      await executeFile("ssh-keygen", ["-y", "-f", privateKey.sourcePath])
    ).stdout
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .join(" ");
  } catch (error) {
    throw new Error(`${label} private key could not be validated`, {
      cause: error,
    });
  }
  if (derivedPublicKey !== publicFields.join(" ")) {
    throw new Error(`${label} private and public keys do not match`);
  }
  return [
    {
      destination: `${sandboxHome}/.ssh/${privateKey.relativePath}`,
      contents: privateKey.contents,
      mode: 0o600,
    },
    {
      destination: `${sandboxHome}/.ssh/${publicKey.relativePath}`,
      contents: publicKey.contents,
      mode: 0o644,
    },
  ];
}

async function loadGithubKnownHosts(
  configuredPath: string,
  homeDirectory: string,
): Promise<RuntimeIdentityFile> {
  const knownHosts = await readAllowlistedSshFile(
    configuredPath,
    homeDirectory,
    "GitHub known_hosts",
  );
  let matches: string;
  try {
    matches = (
      await executeFile("ssh-keygen", [
        "-F",
        "github.com",
        "-f",
        knownHosts.sourcePath,
      ])
    ).stdout;
  } catch (error) {
    throw new Error(
      `GitHub known_hosts has no usable github.com entry: ${knownHosts.sourcePath}`,
      { cause: error },
    );
  }
  const githubEntries = matches
    .split("\n")
    .filter((line) => line && !line.startsWith("#"));
  if (githubEntries.length === 0) {
    throw new Error(
      `GitHub known_hosts has no usable github.com entry: ${knownHosts.sourcePath}`,
    );
  }
  return {
    destination: `${sandboxHome}/.ssh/known_hosts`,
    contents: `${githubEntries.join("\n")}\n`,
    mode: 0o600,
  };
}

async function requiredGitConfig(
  repositoryRoot: string,
  key: string,
  boolean = false,
): Promise<string> {
  try {
    const args = ["-C", repositoryRoot, "config"];
    if (boolean) args.push("--type=bool");
    args.push("--get", key);
    return nonEmptyStringSchema.parse((await executeFile("git", args)).stdout);
  } catch (error) {
    throw new Error(
      `Effective Git configuration is missing or invalid: ${key}`,
      {
        cause: error,
      },
    );
  }
}

function uniqueRuntimeFiles(
  files: RuntimeIdentityFile[],
): RuntimeIdentityFile[] {
  const byDestination = new Map<string, RuntimeIdentityFile>();
  for (const file of files) {
    const existing = byDestination.get(file.destination);
    if (
      existing &&
      (existing.contents !== file.contents || existing.mode !== file.mode)
    ) {
      throw new Error(
        `Runtime identity destinations conflict: ${file.destination}`,
      );
    }
    byDestination.set(file.destination, file);
  }
  return [...byDestination.values()];
}

export async function loadRuntimeIdentityBundle(
  repositoryRoot: string,
  options: LoadRuntimeIdentityOptions = {},
): Promise<RuntimeIdentityBundle> {
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const environment = options.environment ?? process.env;
  const [userName, userEmail, gpgFormat, commitSigning, signingKey] =
    await Promise.all([
      requiredGitConfig(repositoryRoot, "user.name"),
      requiredGitConfig(repositoryRoot, "user.email"),
      requiredGitConfig(repositoryRoot, "gpg.format"),
      requiredGitConfig(repositoryRoot, "commit.gpgsign", true),
      requiredGitConfig(repositoryRoot, "user.signingkey"),
    ]);
  if (gpgFormat !== "ssh") {
    throw new Error("Effective Git gpg.format must be ssh");
  }
  if (commitSigning !== "true") {
    throw new Error("Effective Git commit.gpgsign must be true");
  }
  if (signingKey.endsWith(".pub")) {
    throw new Error(
      "Effective Git user.signingkey must point to a private key because ssh-agent signing is unavailable",
    );
  }

  const authKey = environment.CUBE_SSH_AUTH_KEY ?? "~/.ssh/id_ed25519";
  const knownHosts =
    environment.CUBE_SSH_KNOWN_HOSTS_FILE ?? "~/.ssh/known_hosts";
  const githubToken = await resolveGithubToken(environment);
  const [jsonFiles, authFiles, signingFiles, knownHostsFile] =
    await Promise.all([
      Promise.all(
        identityFileSpecs.map((spec) =>
          loadJsonIdentityFile(homeDirectory, spec),
        ),
      ),
      loadSshKeyPair(authKey, homeDirectory, "SSH auth"),
      loadSshKeyPair(signingKey, homeDirectory, "Git signing"),
      githubToken
        ? Promise.resolve(undefined)
        : loadGithubKnownHosts(knownHosts, homeDirectory),
    ]);
  const files = uniqueRuntimeFiles([
    ...jsonFiles,
    ...authFiles,
    ...signingFiles,
    ...(knownHostsFile ? [knownHostsFile] : []),
  ]);
  const privateAuthFile = authFiles.find((file) => file.mode === 0o600)!;
  const privateSigningFile = signingFiles.find((file) => file.mode === 0o600)!;
  return {
    files,
    git: {
      userName,
      userEmail,
      authKeyPath: privateAuthFile.destination,
      signingKeyPath: privateSigningFile.destination,
      ...(knownHostsFile ? { knownHostsPath: knownHostsFile.destination } : {}),
    },
    ...(githubToken ? { githubToken } : {}),
  };
}
