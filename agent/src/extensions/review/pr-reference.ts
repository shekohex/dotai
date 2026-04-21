import type { ParsedPrReference } from "./types.js";

export function parsePrReference(ref: string): ParsedPrReference | null {
  const trimmed = ref.trim();
  if (/^\d+$/.test(trimmed)) {
    const number = Number.parseInt(trimmed, 10);
    if (!Number.isInteger(number) || number <= 0) {
      return null;
    }
    return { prNumber: number };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.hostname !== "github.com") {
    return null;
  }

  const pathMatch = url.pathname.match(/^\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/.*)?$/);
  if (
    pathMatch?.[1] === undefined ||
    pathMatch[1].length === 0 ||
    pathMatch?.[2] === undefined ||
    pathMatch[2].length === 0
  ) {
    return null;
  }

  const prNumberFromUrl = Number.parseInt(pathMatch[2], 10);
  if (!Number.isInteger(prNumberFromUrl) || prNumberFromUrl <= 0) {
    return null;
  }

  return {
    prNumber: prNumberFromUrl,
    repo: pathMatch[1],
  };
}
