import type { ProviderHeaders } from "@earendil-works/pi-ai";

export function providerHeadersToRecord(
  headers: ProviderHeaders | undefined,
): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  const resolvedHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase();
    const existingName = Object.keys(resolvedHeaders).find(
      (candidate) => candidate.toLowerCase() === normalizedName,
    );
    if (existingName !== undefined) delete resolvedHeaders[existingName];
    if (value !== null) resolvedHeaders[name] = value;
  }
  return resolvedHeaders;
}
