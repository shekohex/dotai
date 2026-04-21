import type { Api, Model } from "@mariozechner/pi-ai";
import type { RemoteExtensionMetadata } from "../schemas.js";
import type { RenderableComponent } from "./types.js";

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

export function isRenderableComponent(value: unknown): value is RenderableComponent {
  if (value === null || typeof value !== "object") {
    return false;
  }
  if (!("render" in value) || !("invalidate" in value)) {
    return false;
  }
  return typeof value.render === "function" && typeof value.invalidate === "function";
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
        extension.host !== nextExtension.host ||
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
    const host: unknown = Reflect.get(extension, "host");
    const extensionPath: unknown = Reflect.get(extension, "path");
    if (
      typeof id === "string" &&
      typeof extensionPath === "string" &&
      (host === "server-bound" || host === "ui-only")
    ) {
      metadata.push({ id, host, path: extensionPath });
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
      host: "server-bound",
      path: extensionPath,
    });
  }

  return metadata;
}
