import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const WRAPPER_PACKAGE_NAME = "@shekohex/agent";
export const WRAPPER_REGISTRY_URL = "https://npm.pkg.github.com";
export const WRAPPER_RAW_PACKAGE_ENDPOINT = "https://npm.pkg.github.com/@shekohex%2fagent";
export const WRAPPER_REPOSITORY = "shekohex/dotai";

export type ReleaseChannel = "latest" | "preview";

export interface RuntimeVersion {
  packageName: string;
  version: string;
  channel: ReleaseChannel;
  commit?: string;
  packageDir: string;
}

const PackageJsonSchema = Type.Object(
  {
    name: Type.Optional(Type.String()),
    version: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

type PackageJson = Static<typeof PackageJsonSchema>;

const PREVIEW_VERSION_RE = /^\d+\.\d+\.\d+-dev\.([0-9a-f]{7,40})$/i;

export function parseVersionChannel(version: string): { channel: ReleaseChannel; commit?: string } {
  const match = PREVIEW_VERSION_RE.exec(version.trim());
  if (match) {
    return { channel: "preview", commit: match[1] };
  }
  return { channel: "latest" };
}

export function getRuntimeVersion(packageDir = findPackageDir()): RuntimeVersion {
  const packageJson = readPackageJson(packageDir);
  const version = packageJson.version ?? "0.0.0";
  const parsed = parseVersionChannel(version);
  const runtimeVersion: RuntimeVersion = {
    packageName: packageJson.name ?? WRAPPER_PACKAGE_NAME,
    version,
    channel: parsed.channel,
    packageDir,
  };
  if (parsed.commit === undefined) {
    return runtimeVersion;
  }
  return { ...runtimeVersion, commit: parsed.commit };
}

export function findPackageDir(startDir = import.meta.dirname): string {
  let currentDir = startDir;
  while (currentDir !== dirname(currentDir)) {
    if (existsSync(join(currentDir, "package.json"))) {
      return currentDir;
    }
    currentDir = dirname(currentDir);
  }
  return startDir;
}

function readPackageJson(packageDir: string): PackageJson {
  const packageJsonPath = join(packageDir, "package.json");
  const rawPackageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as unknown;
  if (!Value.Check(PackageJsonSchema, rawPackageJson)) {
    return {};
  }
  return rawPackageJson;
}
