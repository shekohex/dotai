import { Value } from "@sinclair/typebox/value";
import type { StructuredSearchResult } from "./types.js";
import {
  MAX_SEARCH_QUERIES,
  MAX_SOURCES,
  StructuredSearchResultSchema,
  type SearchResult,
  type WebSearchSource,
} from "./types.js";

function emptyResult(): SearchResult {
  return { answer: "", sources: [], searchQueries: [] };
}

function parseSearchResponseText(text: string): SearchResult {
  const normalized = text.trim();
  if (!normalized) {
    return emptyResult();
  }
  const structured = parseStructuredSearchJson(normalized);
  return (
    structured ?? { answer: stripWrappingCodeFence(normalized), sources: [], searchQueries: [] }
  );
}

function extractStreamingAnswerText(text: string): string {
  const normalized = text.trim();
  if (!normalized) {
    return "";
  }
  if (normalized.startsWith("{") && !normalized.includes('"answer"')) {
    return "";
  }
  const answerValue = extractPartialJsonStringValue(normalized, "answer");
  if (answerValue !== undefined) {
    return answerValue.trim();
  }
  return normalized.startsWith("{") ? "" : stripWrappingCodeFence(normalized);
}

function parseStructuredSearchJson(text: string): SearchResult | undefined {
  const candidateJsons = extractTopLevelJsonObjects(stripWrappingCodeFence(text));
  if (candidateJsons.length === 0) {
    return undefined;
  }
  const sources = new Map<string, WebSearchSource>();
  const searchQueries = new Set<string>();
  let answer = "";
  try {
    for (const candidateJson of candidateJsons) {
      const parsedCandidate: unknown = JSON.parse(candidateJson);
      if (!Value.Check(StructuredSearchResultSchema, parsedCandidate)) {
        continue;
      }
      const parsed: StructuredSearchResult = Value.Parse(
        StructuredSearchResultSchema,
        parsedCandidate,
      );
      const parsedAnswer = parsed.answer?.trim();
      if (parsedAnswer !== undefined && parsedAnswer.length > 0) {
        answer = parsedAnswer;
      }
      for (const source of parsed.sources ?? []) {
        addSource(sources, source.title, source.url);
      }
      for (const searchQuery of parsed.searchQueries ?? []) {
        addSearchQuery(searchQueries, searchQuery);
      }
    }
  } catch {
    return undefined;
  }
  if (answer.length === 0 && sources.size === 0 && searchQueries.size === 0) {
    return undefined;
  }
  return { answer, sources: [...sources.values()], searchQueries: [...searchQueries] };
}

function extractTopLevelJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaping = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }
    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return objects;
}

function stripWrappingCodeFence(text: string): string {
  return text.replaceAll(/^```\w*\n?|```$/g, "").trim();
}

function addSource(
  sources: Map<string, WebSearchSource>,
  title: string | undefined,
  url: string | undefined,
): void {
  const normalizedTitle = title?.trim();
  const normalizedUrl = url?.trim();
  if (
    normalizedTitle === undefined ||
    normalizedTitle.length === 0 ||
    normalizedUrl === undefined ||
    normalizedUrl.length === 0 ||
    sources.has(normalizedUrl) ||
    sources.size >= MAX_SOURCES
  ) {
    return;
  }
  sources.set(normalizedUrl, { title: normalizedTitle, url: normalizedUrl });
}

function addSearchQuery(searchQueries: Set<string>, searchQuery: string | undefined): void {
  const normalized = searchQuery?.trim();
  if (
    normalized === undefined ||
    normalized.length === 0 ||
    searchQueries.has(normalized) ||
    searchQueries.size >= MAX_SEARCH_QUERIES
  ) {
    return;
  }
  searchQueries.add(normalized);
}

function extractPartialJsonStringValue(text: string, key: string): string | undefined {
  const match = new RegExp(`"${escapeRegex(key)}"\\s*:\\s*"`, "m").exec(text);
  if (!match) {
    return undefined;
  }
  let index = match.index + match[0].length;
  let value = "";
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      return value;
    }
    if (char !== "\\") {
      value += char;
      index += 1;
      continue;
    }
    const next = text[index + 1];
    if (next === undefined) {
      return value;
    }
    if (next === "u") {
      const hex = text.slice(index + 2, index + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        return value;
      }
      value += String.fromCodePoint(Number.parseInt(hex, 16));
      index += 6;
      continue;
    }
    value += decodeJsonEscape(next);
    index += 2;
  }
  return value;
}

function decodeJsonEscape(value: string): string {
  switch (value) {
    case '"':
      return '"';
    case "\\":
      return "\\";
    case "/":
      return "/";
    case "b":
      return "\b";
    case "f":
      return "\f";
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    default:
      return value;
  }
}

function escapeRegex(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export { emptyResult, extractStreamingAnswerText, parseSearchResponseText };
