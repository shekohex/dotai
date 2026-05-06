import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isStaleSessionReplacementContextError } from "../session-replacement.js";

const SHIMMER_INTERVAL_MS = 100;
const SHIMMER_BASE_STYLE = "\u001B[2m";
const SHIMMER_TRAIL_STYLE = "\u001B[37m";
const SHIMMER_HIGHLIGHT_STYLE = "\u001B[1;97m";
const RESET_STYLE = "\u001B[22;39m";

export function startCoreUIWorkingMessageShimmer(
  ctx: ExtensionContext,
  message: string,
): ReturnType<typeof setInterval> {
  let offset = 0;

  try {
    ctx.ui.setWorkingMessage(renderShimmerFrame(message, offset));
  } catch (error) {
    if (!isStaleSessionReplacementContextError(error)) {
      throw error;
    }
  }

  const shimmerInterval = setInterval(() => {
    offset = (offset + 1) % Math.max(message.length, 1);
    try {
      ctx.ui.setWorkingMessage(renderShimmerFrame(message, offset));
    } catch (error) {
      if (!isStaleSessionReplacementContextError(error)) {
        throw error;
      }
      clearInterval(shimmerInterval);
    }
  }, SHIMMER_INTERVAL_MS);

  return shimmerInterval;
}

export function stopCoreUIWorkingMessageShimmer(
  shimmerInterval: ReturnType<typeof setInterval> | undefined,
  ctx: ExtensionContext,
): undefined {
  if (shimmerInterval !== undefined) {
    clearInterval(shimmerInterval);
  }

  try {
    ctx.ui.setWorkingMessage();
  } catch (error) {
    if (!isStaleSessionReplacementContextError(error)) {
      throw error;
    }
  }
  return undefined;
}

function renderShimmerFrame(message: string, highlightOffset: number): string {
  return Array.from(message)
    .map((character, index) => colorizeCharacter(character, index - highlightOffset))
    .join("");
}

function colorizeCharacter(character: string, distanceFromHighlight: number): string {
  if (character === " ") {
    return character;
  }

  const absoluteDistance = Math.abs(distanceFromHighlight);
  const style = resolveCharacterStyle(absoluteDistance);

  return `${style}${character}${RESET_STYLE}`;
}

function resolveCharacterStyle(absoluteDistance: number): string {
  if (absoluteDistance === 0) {
    return SHIMMER_HIGHLIGHT_STYLE;
  }

  if (absoluteDistance === 1) {
    return SHIMMER_TRAIL_STYLE;
  }

  return SHIMMER_BASE_STYLE;
}
