import { spawn, spawnSync } from "node:child_process";
import { resolveAuthToken, verifyGitHubPackagesAccess } from "./auth.js";
import { getLatestPackageRelease, isCurrentRelease } from "./github-packages.js";
import { readInstallState, writeInstallState } from "./install-state.js";
import {
  createUpdateCommand,
  makePackageSpec,
  parseRequestedInstallMethod,
  resolveInstallMethod,
  stripInstallMethodFlags,
  withTemporaryNpmrc,
} from "./package-manager.js";
import type { InstallMethod, PackageManagerCommand } from "./package-manager.js";
import { getRuntimeVersion, WRAPPER_RAW_PACKAGE_ENDPOINT } from "./version.js";
import type { RuntimeVersion } from "./version.js";

interface UpdateOptions {
  args: string[];
  packageDir?: string;
}

type UpdateTarget = "all" | "self" | "extensions" | "extension";

interface ParsedUpdateCommand {
  target: UpdateTarget;
  force: boolean;
  extensionSource?: string;
  requestedMethod?: InstallMethod;
  passthroughArgs: string[];
}

export async function handleWrapperUpdateCommand(options: UpdateOptions): Promise<boolean> {
  if (process.env.SHEKOHEX_AGENT_BYPASS_UPDATE === "1") {
    return false;
  }
  const parsed = parseUpdateCommand(options.args);
  if (!parsed) {
    return false;
  }
  if (parsed.target === "extensions" || parsed.target === "extension") {
    return false;
  }

  if (parsed.target === "all") {
    runUpstreamExtensionsUpdate(parsed.passthroughArgs);
  }

  await runWrapperSelfUpdate(parsed, getRuntimeVersion(options.packageDir));
  return true;
}

export function parseUpdateCommand(args: string[]): ParsedUpdateCommand | undefined {
  if (args[0] !== "update") {
    return undefined;
  }
  if (args.includes("--help") || args.includes("-h")) {
    return undefined;
  }
  const requestedMethod = parseRequestedInstallMethod(args);
  const strippedArgs = stripInstallMethodFlags(args);
  const force = strippedArgs.includes("--force");
  const selfFlag = strippedArgs.includes("--self");
  const extensionsFlag = strippedArgs.includes("--extensions");
  const extensionIndex = strippedArgs.indexOf("--extension");
  const extensionSource = extensionIndex >= 0 ? strippedArgs[extensionIndex + 1] : undefined;
  const source = strippedArgs.slice(1).find((arg) => !arg.startsWith("-"));
  const target = resolveUpdateTarget({ selfFlag, extensionsFlag, extensionSource, source });
  const command: ParsedUpdateCommand = {
    target,
    force,
    passthroughArgs: strippedArgs,
  };
  if (extensionSource !== undefined) {
    command.extensionSource = extensionSource;
  }
  if (requestedMethod !== undefined) {
    command.requestedMethod = requestedMethod;
  }
  return command;
}

function resolveUpdateTarget(input: {
  selfFlag: boolean;
  extensionsFlag: boolean;
  extensionSource?: string;
  source?: string;
}): UpdateTarget {
  if (input.extensionSource !== undefined) return "extension";
  if (input.source !== undefined && input.source !== "self" && input.source !== "pi")
    return "extension";
  if (input.extensionsFlag && !input.selfFlag && !input.source) return "extensions";
  if (input.selfFlag || input.source === "self" || input.source === "pi") {
    return input.extensionsFlag ? "all" : "self";
  }
  return "all";
}

async function runWrapperSelfUpdate(
  parsed: ParsedUpdateCommand,
  runtimeVersion: RuntimeVersion,
): Promise<void> {
  const token = resolveAuthToken();
  if (token === undefined) {
    throw new Error(
      "no GitHub token found. Set NODE_AUTH_TOKEN, NPM_TOKEN, GH_TOKEN, or GITHUB_TOKEN, or run `gh auth login && gh auth refresh -s read:packages`.",
    );
  }
  await verifyGitHubPackagesAccess(token, WRAPPER_RAW_PACKAGE_ENDPOINT);

  const installState = readInstallState();
  const method = resolveInstallMethod({
    requestedMethod: parsed.requestedMethod,
    installState,
    packageDir: runtimeVersion.packageDir,
  });
  if (!method) {
    throw new Error(
      "cannot detect install method. Run `pi update --npm`, `pi update --pnpm`, `pi update --bun`, or `pi update --yarn`.",
    );
  }

  const latestRelease = await getLatestPackageRelease(runtimeVersion.channel, token);
  if (!parsed.force && isCurrentRelease(runtimeVersion, latestRelease)) {
    console.log(`pi is already up to date (v${runtimeVersion.version})`);
    writeInstallStateFromRelease(method, latestRelease);
    return;
  }

  const packageSpec = makePackageSpec(latestRelease.version, method, latestRelease.channel);
  await runPackageManagerUpdate({ method, packageSpec, token });
  writeInstallStateFromRelease(method, latestRelease);
  console.log(`Updated pi to v${latestRelease.version}`);
}

async function runPackageManagerUpdate(input: {
  method: InstallMethod;
  packageSpec: string;
  token: NonNullable<ReturnType<typeof resolveAuthToken>>;
}): Promise<void> {
  await withTemporaryNpmrc(input.token, (npmrcPath) =>
    runCommand(
      createUpdateCommand({ method: input.method, packageSpec: input.packageSpec, npmrcPath }),
    ),
  );
}

async function runCommand(command: PackageManagerCommand): Promise<void> {
  console.log(`Updating pi with ${command.display}...`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.command, command.args, { stdio: "inherit", env: command.env });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
      } else if (signal) {
        reject(new Error(`${command.display} terminated by signal ${signal}`));
      } else {
        reject(new Error(`${command.display} exited with code ${code ?? "unknown"}`));
      }
    });
  });
}

function runUpstreamExtensionsUpdate(args: string[]): void {
  const updateArgs = ["update", "--extensions", ...getTrustArgs(args)];
  const entrypoint = process.argv[1];
  if (entrypoint === undefined || entrypoint.length === 0) {
    throw new Error("cannot resolve pi entrypoint for extension update");
  }
  const result = spawnSync(process.execPath, [entrypoint, ...updateArgs], {
    stdio: "inherit",
    env: { ...process.env, SHEKOHEX_AGENT_BYPASS_UPDATE: "1" },
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function getTrustArgs(args: readonly string[]): string[] {
  if (args.includes("--approve") || args.includes("-a")) {
    return ["--approve"];
  }
  if (args.includes("--no-approve") || args.includes("-na")) {
    return ["--no-approve"];
  }
  return [];
}

function writeInstallStateFromRelease(
  method: InstallMethod,
  release: { channel: "latest" | "preview"; version: string; commit?: string },
): void {
  const state = {
    installMethod: method,
    channel: release.channel,
    version: release.version,
  };
  if (release.commit === undefined) {
    writeInstallState(state);
    return;
  }
  writeInstallState({ ...state, commit: release.commit });
}
