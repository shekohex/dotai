import type { Api, Model } from "@mariozechner/pi-ai";
import { Value } from "@sinclair/typebox/value";
import { RemoteExtensionMetadataSchema, type RemoteExtensionMetadata } from "../schemas.js";

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
    if (!Value.Check(RemoteExtensionMetadataSchema, extension)) {
      continue;
    }
    metadata.push(Value.Parse(RemoteExtensionMetadataSchema, extension));
  }

  return metadata;
}

export function parseResourceLoaderExtensionMetadata(value: unknown): RemoteExtensionMetadata[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const metadata: RemoteExtensionMetadata[] = [];
  for (const extension of value) {
    if (!hasPathProperty(extension)) {
      continue;
    }

    const path = extension.path;
    metadata.push({
      id: path,
      runtime: "server",
      path,
    });
  }

  return metadata;
}

function hasPathProperty(value: unknown): value is { path: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "path" in value &&
    typeof value.path === "string" &&
    value.path.length > 0
  );
}
