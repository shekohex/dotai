import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const SearchToolMatchKindSchema = Type.Union([
  Type.Literal("exact_name"),
  Type.Literal("exact_alias"),
  Type.Literal("fuzzy_name"),
  Type.Literal("fuzzy_alias"),
  Type.Literal("description"),
  Type.Literal("none"),
]);

export type SearchToolMatchKind = Static<typeof SearchToolMatchKindSchema>;

export const SearchToolDecisionSchema = Type.Union([
  Type.Literal("matched"),
  Type.Literal("ambiguous"),
  Type.Literal("no_match"),
]);

export type SearchToolDecision = Static<typeof SearchToolDecisionSchema>;

export const SearchToolCandidateScoreSchema = Type.Object({
  name: Type.String(),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  kind: SearchToolMatchKindSchema,
  matchedText: Type.Optional(Type.String()),
});

export type SearchToolCandidateScore = Static<typeof SearchToolCandidateScoreSchema>;

export const SearchToolsResultDetailsSchema = Type.Object({
  query: Type.String(),
  matches: Type.Array(Type.String()),
  added: Type.Array(Type.String()),
  alreadyActive: Type.Array(Type.String()),
  candidates: Type.Array(SearchToolCandidateScoreSchema),
  decision: SearchToolDecisionSchema,
  minimumConfidence: Type.Number({ minimum: 0, maximum: 1 }),
  minimumWinnerMargin: Type.Number({ minimum: 0, maximum: 1 }),
});

export type SearchToolsResultDetails = Static<typeof SearchToolsResultDetailsSchema>;

export interface SearchToolCandidate {
  readonly name: string;
  readonly description: string;
  readonly aliases: readonly string[];
}

export interface SearchToolRanking {
  readonly query: string;
  readonly matches: string[];
  readonly candidates: SearchToolCandidateScore[];
  readonly decision: SearchToolDecision;
  readonly minimumConfidence: number;
  readonly minimumWinnerMargin: number;
}

export function parseSearchToolsResultDetails(
  value: unknown,
): SearchToolsResultDetails | undefined {
  if (!Value.Check(SearchToolsResultDetailsSchema, value)) return undefined;
  return Value.Parse(SearchToolsResultDetailsSchema, value);
}
