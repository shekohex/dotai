import { describe, expect, test } from "vitest";

import {
  jaroWinkler,
  normalizedDamerauLevenshtein,
  phraseSimilarity,
  sorensenDice,
  tokenSimilarity,
} from "../src/extensions/search-tools.js";

describe("normalized Damerau-Levenshtein", () => {
  test("returns one for identical strings", () => {
    expect(normalizedDamerauLevenshtein("workflow", "workflow")).toBe(1);
  });

  test("returns zero when one string is empty", () => {
    expect(normalizedDamerauLevenshtein("", "workflow")).toBe(0);
  });

  test("scores a single insertion", () => {
    expect(normalizedDamerauLevenshtein("kitten", "kittens")).toBeCloseTo(6 / 7);
  });

  test("scores a single deletion", () => {
    expect(normalizedDamerauLevenshtein("kittens", "kitten")).toBeCloseTo(6 / 7);
  });

  test("scores a single substitution", () => {
    expect(normalizedDamerauLevenshtein("kitten", "sitten")).toBeCloseTo(5 / 6);
  });

  test("counts an adjacent transposition as one edit", () => {
    expect(normalizedDamerauLevenshtein("workflow", "workflwo")).toBeCloseTo(7 / 8);
  });

  test("supports unrestricted substring edits", () => {
    expect(normalizedDamerauLevenshtein("ca", "abc")).toBeCloseTo(1 / 3);
  });
});

describe("Jaro-Winkler", () => {
  test("returns one for identical strings", () => {
    expect(jaroWinkler("session", "session")).toBe(1);
  });

  test("returns zero when one string is empty", () => {
    expect(jaroWinkler("", "session")).toBe(0);
  });

  test("returns zero for strings without shared characters", () => {
    expect(jaroWinkler("abc", "xyz")).toBe(0);
  });

  test("does not boost a common prefix below the Jaro threshold", () => {
    expect(jaroWinkler("abxxxx", "abyyyy")).toBeCloseTo(5 / 9);
  });

  test("matches the canonical MARTHA example", () => {
    expect(jaroWinkler("MARTHA", "MARHTA")).toBeCloseTo(0.961_111, 5);
  });

  test("matches the canonical DIXON example", () => {
    expect(jaroWinkler("DIXON", "DICKSONX")).toBeCloseTo(0.813_333, 5);
  });
});

describe("Sørensen-Dice", () => {
  test("returns one for identical strings", () => {
    expect(sorensenDice("conversation", "conversation")).toBe(1);
  });

  test("returns zero for different one-character strings", () => {
    expect(sorensenDice("a", "b")).toBe(0);
  });

  test("matches the canonical night and nacht example", () => {
    expect(sorensenDice("night", "nacht")).toBe(0.25);
  });

  test("counts duplicate bigrams as a multiset", () => {
    expect(sorensenDice("gggg", "gg")).toBe(0.5);
  });

  test("is symmetric", () => {
    expect(sorensenDice("context", "contact")).toBe(sorensenDice("contact", "context"));
  });
});

describe("combined similarity", () => {
  test("keeps the strongest token and phrase similarity", () => {
    expect(tokenSimilarity("workflwo", "workflow")).toBeGreaterThan(0.85);
    expect(phraseSimilarity("multiagent", "multi agent")).toBeGreaterThan(0.9);
  });
});
