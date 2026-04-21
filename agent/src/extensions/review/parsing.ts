import type { ParsedReviewArgs, ReviewRequestedTargetType } from "./types.js";

export { parsePrReference } from "./pr-reference.js";

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

export function normalizeReviewTargetToken(
  value: string | undefined,
): ReviewRequestedTargetType | undefined {
  const normalizedValue = value?.toLowerCase();
  switch (normalizedValue) {
    case undefined:
      return undefined;
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
  const collected = initialValue !== undefined && initialValue.length > 0 ? [initialValue] : [];
  let nextIndex = startIndex;

  while (nextIndex < parts.length) {
    const part = parts[nextIndex];
    if (part.startsWith("--")) {
      break;
    }
    if (
      options.stopAtTarget === true &&
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
  if (args === undefined || args.trim().length === 0) {
    return { target: null };
  }

  const rawParts = tokenizeArgs(args.trim());
  const parsedFlags = parseReviewFlags(rawParts);
  if (parsedFlags.error !== undefined) {
    return { target: null, error: parsedFlags.error };
  }

  return buildParsedReviewArgs(parsedFlags);
}

function parseReviewFlags(rawParts: string[]): {
  parts: string[];
  extraInstruction: string | undefined;
  handoffRequested: boolean;
  handoffInstruction: string | undefined;
  error?: string;
} {
  const parts: string[] = [];
  let extraInstruction: string | undefined;
  let handoffRequested = false;
  let handoffInstruction: string | undefined;

  for (let index = 0; index < rawParts.length; index++) {
    const part = rawParts[index];
    const stopAtTarget = parts.length === 0;
    if (part === "--extra" || part.startsWith("--extra=")) {
      const consumed = consumeExtraReviewFlagValue(rawParts, index, part, stopAtTarget);
      if (consumed.error !== undefined) {
        return {
          parts,
          extraInstruction,
          handoffRequested,
          handoffInstruction,
          error: consumed.error,
        };
      }
      extraInstruction = consumed.value;
      index = consumed.nextIndex - 1;
      continue;
    }

    if (part === "--handoff" || part.startsWith("--handoff=")) {
      handoffRequested = true;
      const consumed = consumeHandoffReviewFlagValue(rawParts, index, part, stopAtTarget);
      if (consumed.value !== undefined && consumed.value.length > 0) {
        handoffInstruction = consumed.value;
        index = consumed.nextIndex - 1;
      }
      continue;
    }

    parts.push(part);
  }

  return { parts, extraInstruction, handoffRequested, handoffInstruction };
}

function consumeExtraReviewFlagValue(
  rawParts: string[],
  index: number,
  part: string,
  stopAtTarget: boolean,
): {
  value: string;
  nextIndex: number;
  error?: string;
} {
  const consumed = consumeFlagValue(rawParts, index + 1, readInlineFlagValue(part, "--extra"), {
    stopAtTarget,
  });
  if (consumed.value === undefined || consumed.value.length === 0) {
    return { value: "", nextIndex: consumed.nextIndex, error: "Missing value for --extra" };
  }
  return { value: consumed.value, nextIndex: consumed.nextIndex };
}

function consumeHandoffReviewFlagValue(
  rawParts: string[],
  index: number,
  part: string,
  stopAtTarget: boolean,
): {
  value?: string;
  nextIndex: number;
} {
  return consumeFlagValue(rawParts, index + 1, readInlineFlagValue(part, "--handoff"), {
    stopAtTarget,
  });
}

function readInlineFlagValue(part: string, flag: "--extra" | "--handoff"): string | undefined {
  const prefix = `${flag}=`;
  return part.startsWith(prefix) ? part.slice(prefix.length) : undefined;
}

function buildParsedReviewArgs(input: {
  parts: string[];
  extraInstruction: string | undefined;
  handoffRequested: boolean;
  handoffInstruction: string | undefined;
}): ParsedReviewArgs {
  const requestedTargetType = normalizeReviewTargetToken(input.parts[0]);
  const base = {
    requestedTargetType,
    extraInstruction: input.extraInstruction,
    handoffRequested: input.handoffRequested,
    handoffInstruction: input.handoffInstruction,
  };
  if (input.parts.length === 0 || requestedTargetType === undefined) {
    return { target: null, ...base };
  }

  switch (requestedTargetType) {
    case "uncommitted":
      return { target: { type: "uncommitted" }, ...base };
    case "branch":
      return {
        target: input.parts[1] ? { type: "baseBranch", branch: input.parts[1] } : null,
        ...base,
      };
    case "commit":
      return {
        target: input.parts[1]
          ? {
              type: "commit",
              sha: input.parts[1],
              title: input.parts.slice(2).join(" ") || undefined,
            }
          : null,
        ...base,
      };
    case "folder": {
      const paths = parseReviewPaths(input.parts.slice(1));
      return { target: paths.length > 0 ? { type: "folder", paths } : null, ...base };
    }
    case "pr":
      return { target: input.parts[1] ? { type: "pr", ref: input.parts[1] } : null, ...base };
  }
  return { target: null, ...base };
}
