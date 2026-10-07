/** Plugin RPC errors arrive as "Request failed: <message> requestType=... code=...". */
export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/^Request failed: /, "")
    .replace(/ requestType=\S+( code=\S+)?$/, "");
}
