export function normalizedDamerauLevenshtein(left: string, right: string): number {
  if (left === right) return 1;
  if (left.length === 0 || right.length === 0) return 0;

  const maximumDistance = left.length + right.length;
  const distances = Array.from({ length: left.length + 2 }, () =>
    Array.from({ length: right.length + 2 }, () => 0),
  );
  distances[0][0] = maximumDistance;
  for (let leftIndex = 0; leftIndex <= left.length; leftIndex += 1) {
    distances[leftIndex + 1][0] = maximumDistance;
    distances[leftIndex + 1][1] = leftIndex;
  }
  for (let rightIndex = 0; rightIndex <= right.length; rightIndex += 1) {
    distances[0][rightIndex + 1] = maximumDistance;
    distances[1][rightIndex + 1] = rightIndex;
  }

  const lastRowByCharacter = new Map<string, number>();
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let lastMatchingColumn = 0;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const transpositionRow = lastRowByCharacter.get(right[rightIndex - 1]) ?? 0;
      const transpositionColumn = lastMatchingColumn;
      let substitutionCost = 1;
      if (left[leftIndex - 1] === right[rightIndex - 1]) {
        substitutionCost = 0;
        lastMatchingColumn = rightIndex;
      }
      distances[leftIndex + 1][rightIndex + 1] = Math.min(
        distances[leftIndex][rightIndex] + substitutionCost,
        distances[leftIndex + 1][rightIndex] + 1,
        distances[leftIndex][rightIndex + 1] + 1,
        distances[transpositionRow][transpositionColumn] +
          (leftIndex - transpositionRow - 1) +
          1 +
          (rightIndex - transpositionColumn - 1),
      );
    }
    lastRowByCharacter.set(left[leftIndex - 1], leftIndex);
  }

  const distance = distances[left.length + 1][right.length + 1];
  return 1 - distance / Math.max(left.length, right.length);
}

export function jaroWinkler(left: string, right: string): number {
  if (left === right) return 1;
  if (left.length === 0 || right.length === 0) return 0;

  const matchDistance = Math.max(0, Math.floor(Math.max(left.length, right.length) / 2) - 1);
  const leftMatches = Array.from({ length: left.length }, () => false);
  const rightMatches = Array.from({ length: right.length }, () => false);
  let matchingCharacters = 0;
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const rightStart = Math.max(0, leftIndex - matchDistance);
    const rightEnd = Math.min(leftIndex + matchDistance + 1, right.length);
    for (let rightIndex = rightStart; rightIndex < rightEnd; rightIndex += 1) {
      if (rightMatches[rightIndex] || left[leftIndex] !== right[rightIndex]) continue;
      leftMatches[leftIndex] = true;
      rightMatches[rightIndex] = true;
      matchingCharacters += 1;
      break;
    }
  }
  if (matchingCharacters === 0) return 0;

  let transpositions = 0;
  let rightIndex = 0;
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    if (!leftMatches[leftIndex]) continue;
    while (!rightMatches[rightIndex]) rightIndex += 1;
    if (left[leftIndex] !== right[rightIndex]) transpositions += 1;
    rightIndex += 1;
  }
  const jaro =
    (matchingCharacters / left.length +
      matchingCharacters / right.length +
      (matchingCharacters - transpositions / 2) / matchingCharacters) /
    3;
  if (jaro <= 0.7) return jaro;
  let commonPrefixLength = 0;
  const maximumPrefixLength = Math.min(4, left.length, right.length);
  while (
    commonPrefixLength < maximumPrefixLength &&
    left[commonPrefixLength] === right[commonPrefixLength]
  ) {
    commonPrefixLength += 1;
  }
  return jaro + commonPrefixLength * 0.1 * (1 - jaro);
}

export function tokenSimilarity(left: string, right: string): number {
  return Math.max(jaroWinkler(left, right), normalizedDamerauLevenshtein(left, right));
}

export function sorensenDice(left: string, right: string): number {
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;

  const leftBigrams = new Map<string, number>();
  for (let index = 0; index < left.length - 1; index += 1) {
    const bigram = left.slice(index, index + 2);
    leftBigrams.set(bigram, (leftBigrams.get(bigram) ?? 0) + 1);
  }
  let intersectionSize = 0;
  for (let index = 0; index < right.length - 1; index += 1) {
    const bigram = right.slice(index, index + 2);
    const availableCount = leftBigrams.get(bigram) ?? 0;
    if (availableCount === 0) continue;
    intersectionSize += 1;
    leftBigrams.set(bigram, availableCount - 1);
  }
  return (2 * intersectionSize) / (left.length + right.length - 2);
}

export function phraseSimilarity(left: string, right: string): number {
  return Math.max(tokenSimilarity(left, right), sorensenDice(left, right));
}
