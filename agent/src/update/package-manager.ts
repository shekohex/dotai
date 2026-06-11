import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { AuthToken } from "./auth.js";
import type { InstallState } from "./install-state.js";
import { WRAPPER_PACKAGE_NAME, WRAPPER_REGISTRY_URL } from "./version.js";

export type InstallMethod = "npm" | "pnpm" | "bun" | "yarn";

export interface PackageManagerCommand {
  command: string;
  args: string[];
  display: string;
  env?: NodeJS.ProcessEnv;
}

export function resolveInstallMethod(options: {
  requestedMethod?: InstallMethod;
  installState?: InstallState;
  packageDir: string;
}): InstallMethod | undefined {
  return (
    options.requestedMethod ??
    options.installState?.installMethod ??
    inferInstallMethod(options.packageDir)
  );
}

export function parseRequestedInstallMethod(args: readonly string[]): InstallMethod | undefined {
  if (args.includes("--npm")) return "npm";
  if (args.includes("--pnpm")) return "pnpm";
  if (args.includes("--bun")) return "bun";
  if (args.includes("--yarn")) return "yarn";
  return undefined;
}

export function stripInstallMethodFlags(args: readonly string[]): string[] {
  return args.filter((arg) => !["--npm", "--pnpm", "--bun", "--yarn"].includes(arg));
}

export function createUpdateCommand(input: {
  method: InstallMethod;
  packageSpec: string;
  npmrcPath: string;
}): PackageManagerCommand {
  switch (input.method) {
    case "npm":
      return makeCommand("npm", [
        "install",
        "--global",
        input.packageSpec,
        "--userconfig",
        input.npmrcPath,
      ]);
    case "pnpm":
      return makeCommand("pnpm", ["add", "--global", input.packageSpec], {
        NPM_CONFIG_USERCONFIG: input.npmrcPath,
      });
    case "bun":
      return makeCommand("bun", ["add", "--global", input.packageSpec], {
        XDG_CONFIG_HOME: dirname(input.npmrcPath),
      });
    case "yarn":
      return makeCommand("yarn", [
        "global",
        "add",
        input.packageSpec,
        "--userconfig",
        input.npmrcPath,
      ]);
  }
  const exhaustiveCheck: never = input.method;
  return exhaustiveCheck;
}

export async function withTemporaryNpmrc<T>(
  token: AuthToken,
  run: (npmrcPath: string) => Promise<T>,
): Promise<T> {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-update-"));
  try {
    const npmrcPath = join(tempDir, ".npmrc");
    writeFileSync(
      npmrcPath,
      `@shekohex:registry=${WRAPPER_REGISTRY_URL}\n//npm.pkg.github.com/:_authToken=${token.value}\n`,
      "utf8",
    );
    return await run(npmrcPath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function makePackageSpec(
  version: string,
  method: InstallMethod,
  channel: "latest" | "preview",
): string {
  if (method === "bun" && channel === "preview") {
    return `${WRAPPER_PACKAGE_NAME}@preview`;
  }
  return `${WRAPPER_PACKAGE_NAME}@${version}`;
}

function inferInstallMethod(packageDir: string): InstallMethod | undefined {
  const rootsByMethod: Array<[InstallMethod, string[]]> = [
    ["npm", commandOutput("npm", ["root", "-g"])],
    ["pnpm", commandOutput("pnpm", ["root", "-g"])],
    ["bun", bunGlobalRoots()],
    ["yarn", yarnGlobalRoots()],
  ];
  return rootsByMethod.find(([, roots]) =>
    roots.some((root) => pathIsInside(packageDir, root)),
  )?.[0];
}

function commandOutput(command: string, args: string[]): string[] {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const output = result.status === 0 ? result.stdout.trim() : "";
  return output.length > 0 ? [output] : [];
}

function bunGlobalRoots(): string[] {
  const bunBinDirs = commandOutput("bun", ["pm", "bin", "-g"]);
  return [
    join(homedir(), ".bun", "install", "global", "node_modules"),
    ...bunBinDirs.map((dir) => join(dirname(dir), "install", "global", "node_modules")),
  ];
}

function yarnGlobalRoots(): string[] {
  return commandOutput("yarn", ["global", "dir"]).flatMap((directoryPath) => [
    directoryPath,
    join(directoryPath, "node_modules"),
  ]);
}

function pathIsInside(childPath: string, parentPath: string): boolean {
  if (!existsSync(parentPath)) {
    return false;
  }
  const normalizedChild = normalizePath(childPath);
  const normalizedParent = normalizePath(parentPath);
  const prefix = normalizedParent.endsWith(sep) ? normalizedParent : `${normalizedParent}${sep}`;
  return normalizedChild === normalizedParent || normalizedChild.startsWith(prefix);
}

function normalizePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function makeCommand(
  command: string,
  args: string[],
  env?: Record<string, string>,
): PackageManagerCommand {
  const packageManagerCommand: PackageManagerCommand = {
    command,
    args,
    display: [command, ...args].map((arg) => formatArg(arg)).join(" "),
  };
  if (env === undefined) {
    return packageManagerCommand;
  }
  return { ...packageManagerCommand, env: { ...process.env, ...env } };
}

function formatArg(arg: string): string {
  return /\s/.test(arg) ? `"${arg}"` : arg;
}
