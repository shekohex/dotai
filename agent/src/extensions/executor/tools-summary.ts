import { countTextLines, summarizeLineCount } from "../coreui/tools.js";
import type { JsonValue } from "./http.js";
import type { ExecuteToolDetails } from "./executor-adapter.js";
import { parseExecutorSearchResults, type ExecutorRenderTheme } from "./tools-shared.js";
import {
  formatDurationSummary,
  resolveStatusColor,
  shouldDisplayDuration,
} from "./tools-call-state.js";
import { extractExecutorDisplayValue, readExecutionId, readStatusValue } from "./tools-text.js";

const formatValueKind = (value: JsonValue): string => {
  const searchResults = parseExecutorSearchResults(value);
  if (searchResults) {
    return `matches(${searchResults.length})`;
  }

  if (Array.isArray(value)) {
    return value.length === 0 ? "empty array" : `array(${value.length})`;
  }

  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    case "bigint":
      return "bigint";
    case "function":
      return "function";
    case "symbol":
      return "symbol";
    case "undefined":
      return "undefined";
    default:
      return "value";
  }
};

const resolveExecuteSummaryStatus = (
  root: JsonValue | undefined,
  structured: JsonValue | undefined,
  displayText: string,
  isError: boolean,
): string => {
  if (isError) {
    return "failed";
  }

  const status = readStatusValue(root) ?? readStatusValue(structured) ?? "done";
  if (status !== "done") {
    return status;
  }

  if (structured === undefined) {
    return displayText.length > 0 ? "returned" : "done";
  }

  return "completed";
};

const appendExecuteSummaryDetails = (
  parts: string[],
  input: {
    details: ExecuteToolDetails | undefined;
    structured: JsonValue | undefined;
    displayText: string;
    durationMs: number | undefined;
    theme: ExecutorRenderTheme;
    isError: boolean;
  },
): void => {
  if (!input.isError && input.structured !== undefined) {
    parts.push(input.theme.fg("muted", formatValueKind(input.structured)));
  } else if (input.structured === undefined && input.displayText.length > 0) {
    parts.push(input.theme.fg("muted", summarizeLineCount(countTextLines(input.displayText))));
  }

  const executionId = readExecutionId(input.details);
  if (executionId !== undefined && executionId.length > 0) {
    parts.push(input.theme.fg("muted", executionId));
  }

  if (shouldDisplayDuration(input.durationMs)) {
    parts.push(input.theme.fg("muted", formatDurationSummary(input.durationMs)));
  }
};

export const buildExecuteSummary = (
  details: ExecuteToolDetails | undefined,
  text: string,
  durationMs: number | undefined,
  theme: ExecutorRenderTheme,
  isError: boolean,
): string => {
  const displayValue = extractExecutorDisplayValue({ content: [{ type: "text", text }], details });
  const structured = displayValue.structured;
  const displayText = displayValue.text ?? text;

  const status = resolveExecuteSummaryStatus(displayValue.root, structured, displayText, isError);
  const statusColor = resolveStatusColor(status, theme, isError);
  const parts = [statusColor(status)];
  appendExecuteSummaryDetails(parts, {
    details,
    structured,
    displayText,
    durationMs,
    theme,
    isError,
  });

  return parts.join(theme.fg("muted", " · "));
};
