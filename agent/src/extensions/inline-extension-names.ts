import {
  DefaultResourceLoader,
  type Extension,
  type ExtensionFactory,
} from "@mariozechner/pi-coding-agent";
import type { LoadExtensionsResult } from "@mariozechner/pi-coding-agent";

const inlineExtensionNameSymbol = Symbol.for("@shekohex/agent/inline-extension-name");
const loaderPatchInstalledSymbol = Symbol.for("@shekohex/agent/inline-extension-name-patch");

type NamedExtensionFactory = ExtensionFactory & {
  [inlineExtensionNameSymbol]?: string;
};

type LoaderLike = {
  extensionFactories?: ExtensionFactory[];
  extensionsResult?: LoadExtensionsResult;
};

type ResourceLoaderReloadMethod = (this: DefaultResourceLoader) => Promise<void>;

function isResourceLoaderReloadMethod(value: unknown): value is ResourceLoaderReloadMethod {
  return typeof value === "function";
}

function toNamedFactory(factory: ExtensionFactory): NamedExtensionFactory {
  return factory as NamedExtensionFactory;
}

function normalizeInlineExtensionName(name: string): string {
  const normalized = name.trim().replaceAll(/[^a-zA-Z0-9._-]+/g, "-");
  return normalized.length > 0 ? normalized : "inline-extension";
}

function readInlineExtensionName(factory: ExtensionFactory): string | undefined {
  const explicitName = toNamedFactory(factory)[inlineExtensionNameSymbol];
  if (typeof explicitName === "string" && explicitName.length > 0) {
    return normalizeInlineExtensionName(explicitName);
  }

  if (typeof factory.name === "string" && factory.name.length > 0) {
    return normalizeInlineExtensionName(factory.name);
  }

  return undefined;
}

function renameLoadedExtension(extension: Extension, nextPath: string): void {
  extension.path = nextPath;
  extension.resolvedPath = nextPath;
  extension.sourceInfo.path = nextPath;

  for (const shortcut of extension.shortcuts.values()) {
    shortcut.extensionPath = nextPath;
  }
}

function renameInlineExtensionPaths(loader: LoaderLike): void {
  const extensionFactories = loader.extensionFactories;
  const extensionsResult = loader.extensionsResult;
  if (!Array.isArray(extensionFactories) || extensionsResult === undefined) {
    return;
  }

  const usedPaths = new Set<string>();
  const inlinePathMap = new Map<string, string>();

  for (const [index, extension] of extensionsResult.extensions.entries()) {
    const currentPath = extension.path;
    const expectedInlinePath = `<inline:${index + 1}>`;
    const factory = extensionFactories[index];
    const baseName = factory === undefined ? undefined : readInlineExtensionName(factory);
    if (baseName === undefined || currentPath !== expectedInlinePath) {
      usedPaths.add(currentPath);
      continue;
    }

    let nextPath = `<${baseName}>`;
    let suffix = 2;
    while (usedPaths.has(nextPath)) {
      nextPath = `<${baseName}:${suffix}>`;
      suffix += 1;
    }

    usedPaths.add(nextPath);
    inlinePathMap.set(currentPath, nextPath);
    renameLoadedExtension(extension, nextPath);
  }

  for (const error of extensionsResult.errors) {
    const renamedPath = inlinePathMap.get(error.path);
    if (renamedPath !== undefined) {
      error.path = renamedPath;
    }
  }
}

export function setInlineExtensionName(factory: ExtensionFactory, name: string): ExtensionFactory {
  toNamedFactory(factory)[inlineExtensionNameSymbol] = normalizeInlineExtensionName(name);
  return factory;
}

export function installInlineExtensionNamePatch(): void {
  const prototypeWithPatchFlag =
    DefaultResourceLoader.prototype as typeof DefaultResourceLoader.prototype & {
      [loaderPatchInstalledSymbol]?: true;
    };
  if (prototypeWithPatchFlag[loaderPatchInstalledSymbol] === true) {
    return;
  }

  const reloadDescriptor = Object.getOwnPropertyDescriptor(
    DefaultResourceLoader.prototype,
    "reload",
  );
  const originalReload =
    reloadDescriptor && isResourceLoaderReloadMethod(reloadDescriptor.value)
      ? reloadDescriptor.value
      : undefined;
  if (originalReload === undefined) {
    return;
  }
  DefaultResourceLoader.prototype.reload = async function patchedReload(
    this: DefaultResourceLoader & LoaderLike,
  ) {
    await originalReload.call(this);
    renameInlineExtensionPaths(this);
  };

  prototypeWithPatchFlag[loaderPatchInstalledSymbol] = true;
}
