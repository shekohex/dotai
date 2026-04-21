import type { SearchResult, SearchResultLike, WebSearchDetails } from "./types.js";

function getTextContent(content: Array<{ type: string; text?: string }>): string {
  return content
    .flatMap((item) => (item.type === "text" && typeof item.text === "string" ? [item.text] : []))
    .join("\n");
}

function getAssistantText(
  content: Array<{ type: string; text?: string } | { type: string; thinking?: string }>,
): string {
  return content
    .flatMap((item) =>
      item.type === "text" && "text" in item && typeof item.text === "string" ? [item.text] : [],
    )
    .join("\n");
}

function formatDurationHuman(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function buildExpandedMarkdown(answer: string, details: SearchResultLike | undefined): string {
  const lines = [answer.trim() || "No answer returned."];
  const sources = details?.sources ?? [];
  const searchQueries = details?.searchQueries ?? [];
  if (sources.length > 0) {
    lines.push("", "## Sources");
    for (const source of sources) {
      lines.push(`- [${escapeMarkdownLinkText(source.title)}](<${source.url}>)`);
    }
  }
  if (searchQueries.length > 0) {
    lines.push("", "## Search queries");
    for (const searchQuery of searchQueries) {
      lines.push(`- ${escapeMarkdownText(searchQuery)}`);
    }
  }
  return lines.join("\n").trim();
}

function buildDetails(
  query: string,
  model: string,
  timeoutMs: number,
  endpoint: string,
  startedAt: number,
  result: SearchResult,
): WebSearchDetails {
  return {
    query,
    model,
    timeoutMs,
    durationMs: Math.max(0, Date.now() - startedAt),
    endpoint,
    answer: result.answer,
    markdown: buildExpandedMarkdown(result.answer.trim() || "No answer returned.", result),
    searchQueries: result.searchQueries,
    sources: result.sources,
  };
}

function formatResult(result: SearchResult): string {
  const lines = [result.answer.trim() || "No answer returned."];
  if (result.sources.length > 0) {
    lines.push("", "Sources:");
    for (const source of result.sources) {
      lines.push(`- ${source.title} — ${source.url}`);
    }
  }
  if (result.searchQueries.length > 0) {
    lines.push("", "Search queries:");
    for (const searchQuery of result.searchQueries) {
      lines.push(`- ${searchQuery}`);
    }
  }
  return lines.join("\n");
}

function escapeMarkdownLinkText(text: string): string {
  return text.replaceAll(/([\\[\]])/g, "\\$1");
}

function escapeMarkdownText(text: string): string {
  return text.replaceAll(/([\\`*_{}[\]()#+\-.!|>])/g, "\\$1");
}

export {
  buildDetails,
  buildExpandedMarkdown,
  formatDurationHuman,
  formatResult,
  getAssistantText,
  getTextContent,
};
