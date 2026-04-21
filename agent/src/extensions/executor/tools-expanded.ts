import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { getMarkdownTheme, type Theme } from "@mariozechner/pi-coding-agent";
import { getTextContent } from "../coreui/tools.js";
import type { JsonValue } from "./http.js";
import type { ExecuteToolDetails } from "./executor-adapter.js";
import {
  parseExecutorSearchResults,
  TOOL_TEXT_PADDING_X,
  TOOL_TEXT_PADDING_Y,
} from "./tools-shared.js";
import {
  extractExecutorDisplayValue,
  formatExecutorTextOutput,
  formatStructuredJson,
} from "./tools-text.js";

const formatExecutorSearchResultsMarkdown = (
  items: Array<{
    path: string;
    name: string;
    description: string;
    sourceId: string;
    score: number;
  }>,
): string =>
  items
    .map((item, index) => {
      const section = [
        `### ${index + 1}. ${item.name}`,
        `- Path: \`${item.path}\``,
        `- Source: \`${item.sourceId}\``,
        `- Score: \`${item.score}\``,
        "",
        item.description.trim(),
      ];
      return section.join("\n");
    })
    .join("\n\n---\n\n");

const appendExpandedExecuteText = (
  container: Container,
  theme: Theme,
  text: string,
  structured: JsonValue | undefined,
): void => {
  if (text.length === 0) {
    return;
  }

  const plainJson =
    structured === undefined ? undefined : JSON.stringify(structured, null, 2).trim();
  if (plainJson !== undefined && plainJson === text.trim()) {
    return;
  }

  container.addChild(
    new Text(formatExecutorTextOutput(text, theme), TOOL_TEXT_PADDING_X, TOOL_TEXT_PADDING_Y),
  );
};

const appendExpandedExecuteStructured = (
  container: Container,
  theme: Theme,
  text: string,
  structured: JsonValue | undefined,
): void => {
  if (structured === undefined) {
    return;
  }

  if (text.length > 0) {
    container.addChild(new Spacer(1));
  }
  const searchResults = parseExecutorSearchResults(structured);
  if (searchResults) {
    container.addChild(
      new Markdown(
        formatExecutorSearchResultsMarkdown(searchResults),
        TOOL_TEXT_PADDING_X,
        TOOL_TEXT_PADDING_Y,
        getMarkdownTheme(),
      ),
    );
    return;
  }

  container.addChild(
    new Text(formatStructuredJson(structured, theme), TOOL_TEXT_PADDING_X, TOOL_TEXT_PADDING_Y),
  );
};

const appendExpandedExecuteEmptyState = (
  container: Container,
  theme: Theme,
  text: string,
  structured: JsonValue | undefined,
  isError: boolean,
): void => {
  if (text.length > 0 || structured !== undefined) {
    return;
  }

  container.addChild(
    new Text(
      isError
        ? theme.fg("error", "Executor returned no output.")
        : theme.fg("muted", "Executor returned no output."),
      TOOL_TEXT_PADDING_X,
      TOOL_TEXT_PADDING_Y,
    ),
  );
};

const appendSummaryToExpandedContainer = (
  container: Container,
  theme: Theme,
  summary: string,
): Container => {
  container.addChild(new Spacer(1));
  container.addChild(
    new Text(`${theme.fg("dim", "↳ ")}${summary}`, TOOL_TEXT_PADDING_X, TOOL_TEXT_PADDING_Y),
  );
  return container;
};

export const renderExpandedExecuteResult = (
  result: { content: Array<{ type: string; text?: string }>; details?: unknown },
  _details: ExecuteToolDetails | undefined,
  theme: Theme,
  lastComponent: unknown,
  summary: string,
  isError: boolean,
): Container => {
  const displayValue = extractExecutorDisplayValue(result);
  const structured = displayValue.structured;
  const text = displayValue.text ?? getTextContent(result);
  const container = lastComponent instanceof Container ? lastComponent : new Container();
  container.clear();
  appendExpandedExecuteText(container, theme, text, structured);
  appendExpandedExecuteStructured(container, theme, text, structured);
  appendExpandedExecuteEmptyState(container, theme, text, structured, isError);
  return appendSummaryToExpandedContainer(container, theme, summary);
};
