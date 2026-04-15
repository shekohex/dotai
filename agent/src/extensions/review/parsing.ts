import type { ParsedPrReference, ParsedReviewArgs, ReviewRequestedTargetType } from "./types.js";

export function tokenizeArgs(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (quote) {
      if (char === "\\" && index + 1 < value.length) {
        current += value[index + 1];
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

export function parseReviewPaths(value: string | string[]): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => item.trim()).filter(Boolean);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.includes("\n")) {
    return trimmed
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return tokenizeArgs(trimmed)
    .map((item) => item.trim())
    .filter(Boolean);
}

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
  if (!pathMatch?.[1] || !pathMatch?.[2]) {
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

export function normalizeReviewTargetToken(
  value: string | undefined,
): ReviewRequestedTargetType | undefined {
  switch (value?.toLowerCase()) {
    case "uncommitted":
    case "u":
      return "uncommitted";
    case "branch":
    case "br":
      return "branch";
    case "commit":
      return "commit";
    case "pr":
      return "pr";
    case "folder":
      return "folder";
    default:
      return undefined;
  }
}

function isReviewTargetToken(value: string | undefined): boolean {
  return normalizeReviewTargetToken(value) !== undefined;
}

function isValidReviewTargetSuffix(parts: string[], index: number): boolean {
  const targetType = normalizeReviewTargetToken(parts[index]);
  if (!targetType) {
    return false;
  }

  const remaining = parts.length - index;
  switch (targetType) {
    case "uncommitted":
      return remaining === 1;
    case "branch":
      return remaining === 2;
    case "pr":
      return remaining === 2;
    case "folder":
      return remaining >= 2;
    case "commit":
      return remaining >= 2;
    default:
      return false;
  }
}

function consumeFlagValue(
  parts: string[],
  startIndex: number,
  initialValue?: string,
  options: { stopAtTarget?: boolean } = {},
): { value?: string; nextIndex: number } {
  const collected = initialValue ? [initialValue] : [];
  let nextIndex = startIndex;

  while (nextIndex < parts.length) {
    const part = parts[nextIndex];
    if (part.startsWith("--")) {
      break;
    }
    if (
      options.stopAtTarget &&
      isReviewTargetToken(part) &&
      isValidReviewTargetSuffix(parts, nextIndex)
    ) {
      break;
    }

    collected.push(part);
    nextIndex += 1;
  }

  return {
    value: collected.length > 0 ? collected.join(" ") : undefined,
    nextIndex,
  };
}

export function parseArgs(args: string | undefined): ParsedReviewArgs {
  if (!args?.trim()) {
    return { target: null };
  }

  const rawParts = tokenizeArgs(args.trim());
  const parts: string[] = [];
  let extraInstruction: string | undefined;
  let handoffRequested = false;
  let handoffInstruction: string | undefined;

  for (let index = 0; index < rawParts.length; index++) {
    const part = rawParts[index];
    const stopAtTarget = parts.length === 0;
    if (part === "--extra") {
      const consumed = consumeFlagValue(rawParts, index + 1, undefined, { stopAtTarget });
      if (!consumed.value) {
        return { target: null, error: "Missing value for --extra" };
      }
      extraInstruction = consumed.value;
      index = consumed.nextIndex - 1;
      continue;
    }

    if (part.startsWith("--extra=")) {
      const consumed = consumeFlagValue(rawParts, index + 1, part.slice("--extra=".length), {
        stopAtTarget,
      });
      extraInstruction = consumed.value;
      index = consumed.nextIndex - 1;
      continue;
    }

    if (part === "--handoff") {
      handoffRequested = true;
      const consumed = consumeFlagValue(rawParts, index + 1, undefined, { stopAtTarget });
      if (consumed.value) {
        handoffInstruction = consumed.value;
        index = consumed.nextIndex - 1;
      }
      continue;
    }

    if (part.startsWith("--handoff=")) {
      handoffRequested = true;
      const consumed = consumeFlagValue(rawParts, index + 1, part.slice("--handoff=".length), {
        stopAtTarget,
      });
      handoffInstruction = consumed.value;
      index = consumed.nextIndex - 1;
      continue;
    }

    parts.push(part);
  }

  const requestedTargetType = normalizeReviewTargetToken(parts[0]);

  if (parts.length === 0) {
    return {
      target: null,
      requestedTargetType,
      extraInstruction,
      handoffRequested,
      handoffInstruction,
    };
  }

  switch (requestedTargetType) {
    case "uncommitted":
      return {
        target: { type: "uncommitted" },
        requestedTargetType,
        extraInstruction,
        handoffRequested,
        handoffInstruction,
      };
    case "branch":
      return parts[1]
        ? {
            target: { type: "baseBranch", branch: parts[1] },
            requestedTargetType,
            extraInstruction,
            handoffRequested,
            handoffInstruction,
          }
        : {
            target: null,
            requestedTargetType,
            extraInstruction,
            handoffRequested,
            handoffInstruction,
          };
    case "commit":
      return parts[1]
        ? {
            target: {
              type: "commit",
              sha: parts[1],
              title: parts.slice(2).join(" ") || undefined,
            },
            requestedTargetType,
            extraInstruction,
            handoffRequested,
            handoffInstruction,
          }
        : {
            target: null,
            requestedTargetType,
            extraInstruction,
            handoffRequested,
            handoffInstruction,
          };
    case "folder": {
      const paths = parseReviewPaths(parts.slice(1));
      return paths.length > 0
        ? {
            target: { type: "folder", paths },
            requestedTargetType,
            extraInstruction,
            handoffRequested,
            handoffInstruction,
          }
        : {
            target: null,
            requestedTargetType,
            extraInstruction,
            handoffRequested,
            handoffInstruction,
          };
    }
    case "pr":
      return parts[1]
        ? {
            target: { type: "pr", ref: parts[1] },
            requestedTargetType,
            extraInstruction,
            handoffRequested,
            handoffInstruction,
          }
        : {
            target: null,
            requestedTargetType,
            extraInstruction,
            handoffRequested,
            handoffInstruction,
          };
    default:
      return {
        target: null,
        requestedTargetType,
        extraInstruction,
        handoffRequested,
        handoffInstruction,
      };
  }
}
