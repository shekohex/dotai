const promptMarker = "Available tools:\n";

export function extractPiDynamicTail(systemPrompt: string): string {
  const markerIndex = systemPrompt.indexOf(promptMarker);
  return markerIndex === -1 ? systemPrompt : systemPrompt.slice(markerIndex);
}
