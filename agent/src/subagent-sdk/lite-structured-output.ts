import type { OutputFormat, RuntimeSubagent, StructuredOutputError } from "./types.js";

export function getStructuredRetryCount(outputFormat: OutputFormat | undefined): number {
  return outputFormat?.type === "json_schema" ? (outputFormat.retryCount ?? 3) : 0;
}

export function buildStructuredError(
  code: StructuredOutputError["code"],
  message: string,
  outputFormat: OutputFormat | undefined,
  attempts = getStructuredRetryCount(outputFormat),
): StructuredOutputError {
  const retryCount = getStructuredRetryCount(outputFormat);
  return { code, message, retryCount, attempts };
}

export function buildStructuredOutputRetryPrompt(state: RuntimeSubagent, attempts: number): string {
  const retryCount = getStructuredRetryCount(state.outputFormat);
  const retriesLeft = Math.max(0, retryCount - attempts);
  return `You must call the StructuredOutput tool with output that matches the schema exactly. Do not end with plain text. Retries left: ${retriesLeft}.`;
}
