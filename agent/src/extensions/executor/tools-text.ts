import { highlightCode } from "@mariozechner/pi-coding-agent";
import { getTextContent, styleToolOutput } from "../coreui/tools.js";
import type { JsonObject, JsonValue } from "./http.js";
import type { ExecuteToolDetails } from "./executor-adapter.js";
import {
  EXECUTE_TAB_WIDTH,
  hasStructuredContentDetails,
  isJsonObject,
  isJsonValue,
  type ExecutorRenderTheme,
} from "./tools-shared.js";

export const trimToUndefined = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
};

const formatControlChar = (char: string): string =>
  `\\x${(char.codePointAt(0) ?? 0).toString(16).padStart(2, "0")}`;

export const sanitizeDisplayText = (text: string): string => {
  const normalized = text.replaceAll(/\r\n?/g, "\n");
  const sanitizedLines = normalized.split("\n").map((line) => {
    let output = "";
    let column = 0;

    for (const char of line) {
      if (char === "\t") {
        const remainder = column % EXECUTE_TAB_WIDTH;
        const spaces = remainder === 0 ? EXECUTE_TAB_WIDTH : EXECUTE_TAB_WIDTH - remainder;
        output += " ".repeat(spaces);
        column += spaces;
        continue;
      }

      if (
        (char >= "\u0000" && char <= "\u0008") ||
        char === "\u000B" ||
        char === "\u000C" ||
        (char >= "\u000E" && char <= "\u001F") ||
        char === "\u007F"
      ) {
        const escaped = formatControlChar(char);
        output += escaped;
        column += escaped.length;
        continue;
      }

      output += char;
      column += 1;
    }

    return output;
  });

  return sanitizedLines.join("\n");
};

export const readStatusValue = (value: JsonValue | undefined): string | undefined => {
  if (!isJsonObject(value) || typeof value.status !== "string") {
    return undefined;
  }

  const normalized = value.status.replaceAll(/[_-]+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
};

export const readExecutionId = (details: ExecuteToolDetails | undefined): string | undefined =>
  typeof details?.executionId === "string" && details.executionId.length > 0
    ? details.executionId
    : undefined;

const tryParseJsonValue = (text: string | undefined): JsonValue | undefined => {
  if (text === undefined || text.length === 0) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(text);
    return isJsonValue(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const tryParseNestedJsonValue = (value: string | undefined, depth = 0): JsonValue | undefined => {
  if (value === undefined || value.length === 0 || depth > 4) {
    return undefined;
  }

  const parsed = tryParseJsonValue(value);
  if (typeof parsed === "string") {
    return tryParseNestedJsonValue(parsed, depth + 1) ?? parsed;
  }

  return parsed;
};

const readTextField = (value: JsonValue | undefined): string | undefined => {
  if (!isJsonObject(value)) {
    return undefined;
  }

  for (const key of ["text", "output", "answer", "markdown", "message"]) {
    if (typeof value[key] === "string") {
      return value[key];
    }
  }

  return undefined;
};

const readTextContentBlocks = (value: JsonValue | undefined): string | undefined => {
  if (!isJsonObject(value) || !Array.isArray(value.content)) {
    return undefined;
  }

  const text = value.content
    .filter(
      (item): item is JsonObject =>
        isJsonObject(item) && item.type === "text" && typeof item.text === "string",
    )
    .map((item) => (typeof item.text === "string" ? item.text : ""))
    .join("\n")
    .trim();

  return text.length > 0 ? text : undefined;
};

const unwrapExecutorPayload = (value: JsonValue | undefined): JsonValue | undefined => {
  let current = value;

  for (let depth = 0; depth < 5; depth++) {
    if (!isJsonObject(current)) {
      return current;
    }

    if ("result" in current) {
      current = current.result;
      continue;
    }

    if ("structuredContent" in current) {
      current = current.structuredContent;
      continue;
    }

    return current;
  }

  return current;
};

export const extractExecutorDisplayValue = (result: {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
}): {
  root?: JsonValue;
  structured?: JsonValue;
  text?: string;
} => {
  const root = readStructuredContent(result);
  const directText = getTextContent(result);
  const candidateValues = [
    unwrapExecutorPayload(root),
    unwrapExecutorPayload(tryParseNestedJsonValue(directText)),
  ];

  for (const candidate of candidateValues) {
    if (candidate === undefined) {
      continue;
    }
    return extractExecutorDisplayCandidate(candidate, root);
  }

  const parsedText = tryParseNestedJsonValue(directText);
  if (parsedText !== undefined) {
    return { root, structured: unwrapExecutorPayload(parsedText) ?? parsedText, text: directText };
  }

  return directText ? { root, text: directText } : { root };
};

const extractExecutorDisplayCandidate = (
  candidate: JsonValue,
  root: JsonValue | undefined,
): {
  root?: JsonValue;
  structured?: JsonValue;
  text?: string;
} => {
  const contentText = readTextContentBlocks(candidate);
  if (contentText !== undefined && contentText.length > 0) {
    return buildExecutorDisplayTextResult(contentText, root);
  }

  const textField = readTextField(candidate);
  if (textField !== undefined && textField.length > 0) {
    return buildExecutorDisplayTextResult(textField, root);
  }

  return { root, structured: candidate };
};

const buildExecutorDisplayTextResult = (
  text: string,
  root: JsonValue | undefined,
): { root?: JsonValue; structured?: JsonValue; text?: string } => {
  const parsed = tryParseNestedJsonValue(text);
  if (parsed === undefined) {
    return { root, text };
  }

  return {
    root,
    structured: unwrapExecutorPayload(parsed) ?? parsed,
    text,
  };
};

export const readStructuredContent = (result: {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
}): JsonValue | undefined => {
  const details = hasStructuredContentDetails(result.details) ? result.details : undefined;
  if (details) {
    return details.structuredContent;
  }

  const text = getTextContent(result as { content: Array<{ type: string; text?: string }> });
  if (text.length === 0) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(text);
    return isJsonValue(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

export const formatStructuredJson = (value: JsonValue, _theme: ExecutorRenderTheme): string =>
  highlightCode(sanitizeDisplayText(JSON.stringify(value, null, 2)), "json").join("\n");

export const formatExecutorTextOutput = (text: string, theme: ExecutorRenderTheme): string => {
  if (text.length === 0) {
    return "";
  }

  try {
    const parsed: unknown = JSON.parse(text);
    return isJsonValue(parsed)
      ? formatStructuredJson(parsed, theme)
      : styleToolOutput(sanitizeDisplayText(text), theme);
  } catch {
    return styleToolOutput(sanitizeDisplayText(text), theme);
  }
};
