const promptMarkers = ["<tools>\n", "Available tools:\n"];

export function extractPiDynamicTail(systemPrompt: string): string {
  const markerIndex = promptMarkers
    .map((marker) => systemPrompt.indexOf(marker))
    .filter((index) => index >= 0)
    .toSorted((left, right) => left - right)[0];
  if (markerIndex === undefined) return systemPrompt;
  return systemPrompt.slice(markerIndex);
}
