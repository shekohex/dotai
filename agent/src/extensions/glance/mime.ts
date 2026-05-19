const MIME_EXTENSION_ENTRIES = [
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["image/avif", "avif"],
] as const;

const mimeTypeToExtension = new Map<string, string>(MIME_EXTENSION_ENTRIES);

function replaceControlCharacters(value: string): string {
  return Array.from(value)
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127 ? " " : character;
    })
    .join("");
}

export function normalizeMimeType(contentType: string | undefined): string | null {
  const mimeType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return mimeType !== undefined && mimeType.length > 0 ? mimeType : null;
}

export function getImageExtension(mimeType: string): string | null {
  return mimeTypeToExtension.get(mimeType) ?? null;
}

export function isSupportedImageMimeType(mimeType: string): boolean {
  return mimeTypeToExtension.has(mimeType);
}

export function sanitizeOriginalFilename(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  const sanitized = replaceControlCharacters(value)
    .replaceAll(/["'`]/g, "")
    .replaceAll(/[\\/]/g, "_")
    .replaceAll(/\s+(?=\.)/g, "")
    .trim()
    .slice(0, 160);

  return sanitized.length > 0 ? sanitized : null;
}
