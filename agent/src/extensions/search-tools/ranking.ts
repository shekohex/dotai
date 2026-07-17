import { phraseSimilarity } from "./similarity.js";
import type { SearchToolCandidate, SearchToolCandidateScore, SearchToolRanking } from "./types.js";

export const SEARCH_TOOLS_MINIMUM_CONFIDENCE = 0.7;
export const SEARCH_TOOLS_MINIMUM_WINNER_MARGIN = 0.06;

const SEARCH_STOP_WORDS = new Set([
  "a",
  "an",
  "can",
  "for",
  "i",
  "me",
  "need",
  "please",
  "the",
  "this",
  "to",
  "tool",
  "use",
  "want",
]);

const MATCH_KIND_PRIORITY = {
  exact_name: 6,
  exact_alias: 5,
  fuzzy_name: 4,
  fuzzy_alias: 3,
  description: 2,
  none: 1,
} as const;

function canonicalToken(token: string): string {
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) {
    return token.slice(0, -1);
  }
  return token;
}

function searchTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((token) => token.length > 1 && !SEARCH_STOP_WORDS.has(token))
    .map((token) => canonicalToken(token));
}

function containsPhrase(queryTokens: readonly string[], phraseTokens: readonly string[]): boolean {
  if (phraseTokens.length === 0 || phraseTokens.length > queryTokens.length) return false;
  return queryTokens.some((_, startIndex) =>
    phraseTokens.every((token, tokenIndex) => queryTokens[startIndex + tokenIndex] === token),
  );
}

function phraseWindows(queryTokens: readonly string[], windowLength: number): string[] {
  if (windowLength === 0 || windowLength > queryTokens.length) return [];
  return queryTokens
    .slice(0, queryTokens.length - windowLength + 1)
    .map((_, startIndex) => queryTokens.slice(startIndex, startIndex + windowLength).join(" "));
}

function fuzzyPhraseConfidence(
  queryTokens: readonly string[],
  phraseTokens: readonly string[],
): number {
  const phrase = phraseTokens.join(" ");
  return Math.max(
    0,
    ...phraseWindows(queryTokens, phraseTokens.length).map((window) =>
      phraseSimilarity(window, phrase),
    ),
  );
}

function exactAliasConfidence(aliasTokenCount: number): number {
  return 0.9 + Math.min(aliasTokenCount, 4) * 0.02;
}

function descriptionConfidence(queryTokens: readonly string[], description: string): number {
  if (queryTokens.length === 0) return 0;
  const descriptionTokens = new Set(searchTokens(description));
  const matchingTokenCount = queryTokens.filter((token) => descriptionTokens.has(token)).length;
  if (matchingTokenCount === 0) return 0;
  const overlap = matchingTokenCount / queryTokens.length;
  const phraseBonus = containsPhrase(searchTokens(description), queryTokens) ? 0.04 : 0;
  return overlap * 0.68 + phraseBonus;
}

function compareCandidateScores(
  left: SearchToolCandidateScore,
  right: SearchToolCandidateScore,
): number {
  return (
    right.confidence - left.confidence ||
    MATCH_KIND_PRIORITY[right.kind] - MATCH_KIND_PRIORITY[left.kind] ||
    left.name.localeCompare(right.name)
  );
}

function bestScore(scores: readonly SearchToolCandidateScore[]): SearchToolCandidateScore {
  return (
    scores.toSorted(compareCandidateScores)[0] ?? {
      name: "",
      confidence: 0,
      kind: "none",
    }
  );
}

function scoreCandidate(
  queryTokens: readonly string[],
  candidate: SearchToolCandidate,
): SearchToolCandidateScore {
  const nameTokens = searchTokens(candidate.name);
  if (containsPhrase(queryTokens, nameTokens)) {
    return { name: candidate.name, confidence: 1, kind: "exact_name", matchedText: candidate.name };
  }

  const aliasTokens = candidate.aliases
    .map((alias) => ({ alias, tokens: searchTokens(alias) }))
    .filter(({ tokens }) => tokens.length > 0);
  const exactAliasScores = aliasTokens
    .filter(({ tokens }) => containsPhrase(queryTokens, tokens))
    .map(({ alias, tokens }) => ({
      name: candidate.name,
      confidence: exactAliasConfidence(tokens.length),
      kind: "exact_alias" as const,
      matchedText: alias,
    }));
  if (exactAliasScores.length > 0) return bestScore(exactAliasScores);

  const fuzzyScores: SearchToolCandidateScore[] = [
    {
      name: candidate.name,
      confidence: fuzzyPhraseConfidence(queryTokens, nameTokens) * 0.92,
      kind: "fuzzy_name",
      matchedText: candidate.name,
    },
    ...aliasTokens.map(({ alias, tokens }) => ({
      name: candidate.name,
      confidence: fuzzyPhraseConfidence(queryTokens, tokens) * 0.86,
      kind: "fuzzy_alias" as const,
      matchedText: alias,
    })),
    {
      name: candidate.name,
      confidence: descriptionConfidence(queryTokens, candidate.description),
      kind: "description",
    },
  ];
  const score = bestScore(fuzzyScores);
  if (score.confidence > 0) return score;
  return { name: candidate.name, confidence: 0, kind: "none" };
}

function selectExactMatches(
  candidates: readonly SearchToolCandidateScore[],
  bestCandidate: SearchToolCandidateScore,
  limit: number,
): string[] {
  return candidates
    .filter(
      (candidate) =>
        candidate.kind.startsWith("exact_") &&
        Math.abs(candidate.confidence - bestCandidate.confidence) < 0.001,
    )
    .slice(0, limit)
    .map((candidate) => candidate.name);
}

export function rankSearchTools(
  query: string,
  candidates: readonly SearchToolCandidate[],
  limit: number,
): SearchToolRanking {
  const queryTokens = searchTokens(query);
  const rankedCandidates = candidates
    .map((candidate) => scoreCandidate(queryTokens, candidate))
    .toSorted(compareCandidateScores);
  const eligibleCandidates = rankedCandidates.filter(
    (candidate) => candidate.confidence >= SEARCH_TOOLS_MINIMUM_CONFIDENCE,
  );
  const bestCandidate = eligibleCandidates[0];
  if (bestCandidate === undefined) {
    return {
      query,
      matches: [],
      candidates: rankedCandidates,
      decision: "no_match",
      minimumConfidence: SEARCH_TOOLS_MINIMUM_CONFIDENCE,
      minimumWinnerMargin: SEARCH_TOOLS_MINIMUM_WINNER_MARGIN,
    };
  }

  if (bestCandidate.kind.startsWith("exact_")) {
    return {
      query,
      matches: selectExactMatches(eligibleCandidates, bestCandidate, limit),
      candidates: rankedCandidates,
      decision: "matched",
      minimumConfidence: SEARCH_TOOLS_MINIMUM_CONFIDENCE,
      minimumWinnerMargin: SEARCH_TOOLS_MINIMUM_WINNER_MARGIN,
    };
  }

  const runnerUp = eligibleCandidates[1];
  if (
    runnerUp !== undefined &&
    bestCandidate.confidence - runnerUp.confidence < SEARCH_TOOLS_MINIMUM_WINNER_MARGIN
  ) {
    return {
      query,
      matches: [],
      candidates: rankedCandidates,
      decision: "ambiguous",
      minimumConfidence: SEARCH_TOOLS_MINIMUM_CONFIDENCE,
      minimumWinnerMargin: SEARCH_TOOLS_MINIMUM_WINNER_MARGIN,
    };
  }

  return {
    query,
    matches: [bestCandidate.name],
    candidates: rankedCandidates,
    decision: "matched",
    minimumConfidence: SEARCH_TOOLS_MINIMUM_CONFIDENCE,
    minimumWinnerMargin: SEARCH_TOOLS_MINIMUM_WINNER_MARGIN,
  };
}

export function rankSearchToolNames(
  query: string,
  candidates: readonly SearchToolCandidate[],
  limit: number,
): string[] {
  return rankSearchTools(query, candidates, limit).matches;
}
