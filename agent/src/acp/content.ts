import type { ImageContent } from "@earendil-works/pi-ai";
import { isRecord } from "../utils/unknown-data.js";

const DEFAULT_MAX_BLOCK_BYTES = 10 * 1024 * 1024;
const IMAGE_MIME_PATTERN = /^image\/(?:png|jpeg|gif|webp)$/;
const BASE64_PATTERN = /^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/;

export interface AcpPromptContent {
  text: string;
  images: ImageContent[];
}

export function convertV1PromptContent(
  content: readonly unknown[],
  maxBlockBytes = DEFAULT_MAX_BLOCK_BYTES,
): AcpPromptContent {
  const text: string[] = [];
  const images: ImageContent[] = [];
  for (const block of content) {
    if (!isRecord(block) || typeof block.type !== "string") {
      throw new TypeError("Unsupported ACP prompt content: invalid block");
    }
    if (block.type === "text" && typeof block.text === "string") {
      text.push(block.text);
      continue;
    }
    if (
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      images.push(validateImage(block.data, block.mimeType, maxBlockBytes));
      text.push(`[Image: ${block.mimeType}]`);
      continue;
    }
    if (
      block.type === "resource_link" &&
      typeof block.name === "string" &&
      typeof block.uri === "string"
    ) {
      text.push(`[Resource: ${block.name}] ${block.uri}`);
      continue;
    }
    if (block.type === "resource" && isRecord(block.resource)) {
      const resource = block.resource;
      if (typeof resource.text === "string" && typeof resource.uri === "string") {
        const mimeType = typeof resource.mimeType === "string" ? resource.mimeType : "text/plain";
        ensureByteLimit(Buffer.byteLength(resource.text), maxBlockBytes, "resource");
        text.push(
          `<resource uri="${resource.uri}" mime="${mimeType}">\n${resource.text}\n</resource>`,
        );
        continue;
      }
      if (typeof resource.blob !== "string" || typeof resource.uri !== "string") {
        throw new TypeError("Unsupported ACP prompt content: invalid resource");
      }
      const mimeType =
        typeof resource.mimeType === "string" ? resource.mimeType : "application/octet-stream";
      images.push(validateImage(resource.blob, mimeType, maxBlockBytes));
      text.push(`[Image resource: ${resource.uri}]`);
      continue;
    }
    throw new TypeError(`Unsupported ACP prompt content: ${block.type}`);
  }
  return { text: text.join("\n"), images };
}

function validateImage(data: string, mimeType: string, maxBlockBytes: number): ImageContent {
  if (!IMAGE_MIME_PATTERN.test(mimeType)) {
    throw new TypeError(`ACP prompt has unsupported image MIME type: ${mimeType}`);
  }
  if (!BASE64_PATTERN.test(data)) throw new TypeError("ACP prompt image has invalid base64");
  const decoded = Buffer.from(data, "base64");
  if (decoded.toString("base64") !== data)
    throw new TypeError("ACP prompt image has invalid base64");
  ensureByteLimit(decoded.byteLength, maxBlockBytes, "image");
  return { type: "image", data, mimeType };
}

function ensureByteLimit(size: number, maxBlockBytes: number, kind: string): void {
  if (size > maxBlockBytes) {
    throw new TypeError(`ACP prompt ${kind} exceeds ${maxBlockBytes} bytes`);
  }
}
