import type { Api, Model } from "@mariozechner/pi-ai";
import type { RemoteExtensionMetadata } from "../schemas.js";

export function isApiModel(value: unknown): value is Model<Api> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as { provider?: unknown; id?: unknown; api?: unknown };
  return (
    typeof candidate.provider === "string" &&
    typeof candidate.id === "string" &&
    typeof candidate.api === "string"
  );
}

export function hasExtensionMetadataChange(
  previous: RemoteExtensionMetadata[],
  next: RemoteExtensionMetadata[],
): boolean {
  return (
    previous.length !== next.length ||
    previous.some((extension, index) => {
      const nextExtension = next[index];
      if (nextExtension === undefined) {
        return true;
      }

      return (
        extension.id !== nextExtension.id ||
        extension.runtime !== nextExtension.runtime ||
        extension.path !== nextExtension.path
      );
    })
  );
}

export function parseRuntimeExtensionMetadata(value: unknown): RemoteExtensionMetadata[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [];
  }

  const metadata: RemoteExtensionMetadata[] = [];
  for (const extension of value) {
    if (extension === null || typeof extension !== "object" || Array.isArray(extension)) {
      continue;
    }

    const id: unknown = Reflect.get(extension, "id");
    const runtime: unknown = Reflect.get(extension, "runtime");
    const extensionPath: unknown = Reflect.get(extension, "path");
    if (
      typeof id === "string" &&
      typeof extensionPath === "string" &&
      (runtime === "server" || runtime === "client")
    ) {
      metadata.push({ id, runtime, path: extensionPath });
    }
  }

  return metadata;
}

export function parseResourceLoaderExtensionMetadata(value: unknown): RemoteExtensionMetadata[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const metadata: RemoteExtensionMetadata[] = [];
  for (const extension of value) {
    if (extension === null || typeof extension !== "object") {
      continue;
    }

    const extensionPath: unknown = Reflect.get(extension, "path");
    if (typeof extensionPath !== "string" || extensionPath.length === 0) {
      continue;
    }
    metadata.push({
      id: extensionPath,
      runtime: "server",
      path: extensionPath,
    });
  }

  return metadata;
}
