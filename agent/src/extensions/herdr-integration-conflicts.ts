import { readFileSync } from "node:fs";

import {
  DefaultResourceLoader,
  type ExtensionFactory,
  type PackageManager,
  type ResolvedPaths,
} from "@earendil-works/pi-coding-agent";

const loaderPatchInstalledSymbol = Symbol.for("@shekohex/agent/herdr-integration-conflict-patch");
const packageManagerPatchInstalledSymbol = Symbol.for(
  "@shekohex/agent/herdr-integration-package-manager-patch",
);
const inlineExtensionNameSymbol = Symbol.for("@shekohex/agent/inline-extension-name");
const BUNDLED_HERDR_REPORTER_NAME = "herdr-agent-state";
const MANAGED_PI_INTEGRATION_MARKER = "HERDR_INTEGRATION_ID=pi";

type NamedExtensionFactory = ExtensionFactory & {
  [inlineExtensionNameSymbol]?: string;
};

type PatchedPackageManager = PackageManager & {
  [packageManagerPatchInstalledSymbol]?: true;
};

type ResourceLoaderReloadMethod = DefaultResourceLoader["reload"];

function isResourceLoaderReloadMethod(value: unknown): value is ResourceLoaderReloadMethod {
  return typeof value === "function";
}

function readObjectProperty(target: object, key: PropertyKey): unknown {
  return Reflect.get(target, key);
}

function readExtensionFactories(loader: DefaultResourceLoader): ExtensionFactory[] {
  const value = readObjectProperty(loader, "extensionFactories");
  return Array.isArray(value)
    ? value.filter((factory): factory is ExtensionFactory => typeof factory === "function")
    : [];
}

function isPackageManager(value: unknown): value is PackageManager {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof readObjectProperty(value, "resolve") === "function" &&
    typeof readObjectProperty(value, "resolveExtensionSources") === "function"
  );
}

function readPackageManager(loader: DefaultResourceLoader): PackageManager | undefined {
  const value = readObjectProperty(loader, "packageManager");
  return isPackageManager(value) ? value : undefined;
}

function isManagedHerdrPiIntegration(path: string): boolean {
  try {
    return readFileSync(path, "utf8").includes(MANAGED_PI_INTEGRATION_MARKER);
  } catch {
    return false;
  }
}

function filterManagedHerdrPiIntegration(paths: ResolvedPaths): ResolvedPaths {
  return {
    ...paths,
    extensions: paths.extensions.filter(
      (extension) => !isManagedHerdrPiIntegration(extension.path),
    ),
  };
}

function hasBundledHerdrReporter(loader: DefaultResourceLoader): boolean {
  return readExtensionFactories(loader).some(
    (factory) =>
      (factory as NamedExtensionFactory)[inlineExtensionNameSymbol] === BUNDLED_HERDR_REPORTER_NAME,
  );
}

function patchPackageManager(packageManager: PackageManager): void {
  const patchedPackageManager = packageManager as PatchedPackageManager;
  if (patchedPackageManager[packageManagerPatchInstalledSymbol] === true) return;

  const originalResolve = packageManager.resolve.bind(packageManager);
  packageManager.resolve = async (...args: Parameters<PackageManager["resolve"]>) =>
    filterManagedHerdrPiIntegration(await originalResolve(...args));

  const originalResolveExtensionSources =
    packageManager.resolveExtensionSources.bind(packageManager);
  packageManager.resolveExtensionSources = async (
    ...args: Parameters<PackageManager["resolveExtensionSources"]>
  ) => filterManagedHerdrPiIntegration(await originalResolveExtensionSources(...args));

  patchedPackageManager[packageManagerPatchInstalledSymbol] = true;
}

export function installHerdrIntegrationConflictPatch(): void {
  const prototypeWithPatchFlag =
    DefaultResourceLoader.prototype as typeof DefaultResourceLoader.prototype & {
      [loaderPatchInstalledSymbol]?: true;
    };
  if (prototypeWithPatchFlag[loaderPatchInstalledSymbol] === true) return;

  const reloadDescriptor = Object.getOwnPropertyDescriptor(
    DefaultResourceLoader.prototype,
    "reload",
  );
  const originalReload =
    reloadDescriptor && isResourceLoaderReloadMethod(reloadDescriptor.value)
      ? reloadDescriptor.value
      : undefined;
  if (originalReload === undefined) return;

  DefaultResourceLoader.prototype.reload = async function patchedReload(
    this: DefaultResourceLoader,
    ...args: Parameters<ResourceLoaderReloadMethod>
  ) {
    const packageManager = readPackageManager(this);
    if (hasBundledHerdrReporter(this) && packageManager !== undefined) {
      patchPackageManager(packageManager);
    }
    await originalReload.apply(this, args);
  };

  prototypeWithPatchFlag[loaderPatchInstalledSymbol] = true;
}
