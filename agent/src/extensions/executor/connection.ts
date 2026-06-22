import { probeExecutorApi } from "./http.js";
import { getExecutorSettings, getExecutorWebUrl } from "./settings.js";

export type ExecutorEndpoint = {
  label: string;
  mcpUrl: string;
  webUrl: string;
};

export type ExecutorConnectionAttempt = {
  label: string;
  mcpUrl: string;
  error: string;
};

export class ExecutorUnavailableError extends Error {
  readonly attempts: ExecutorConnectionAttempt[];

  constructor(attempts: ExecutorConnectionAttempt[]) {
    super(
      [
        "Executor unavailable.",
        ...attempts.map((attempt) => `${attempt.label} ${attempt.mcpUrl} -> ${attempt.error}`),
      ].join("\n"),
    );
    this.name = "ExecutorUnavailableError";
    this.attempts = attempts;
  }
}

const formatError = (error: unknown): string => errorMessage(error);

const assertMcpUrl = (mcpUrl: string): string => {
  try {
    return new URL(mcpUrl).toString().replace(/\/+$/, "");
  } catch (error) {
    throw new Error(`Invalid Executor MCP URL: ${formatError(error)}`, { cause: error });
  }
};

export async function resolveExecutorEndpoint(): Promise<ExecutorEndpoint> {
  const settings = getExecutorSettings();
  const attempts: ExecutorConnectionAttempt[] = [];

  for (const candidate of settings.candidates) {
    const mcpUrl = assertMcpUrl(candidate.mcpUrl);

    try {
      await probeExecutorApi(mcpUrl, settings.probeTimeoutMs);
      return {
        label: candidate.label,
        mcpUrl,
        webUrl: getExecutorWebUrl(mcpUrl),
      };
    } catch (error) {
      attempts.push({
        label: candidate.label,
        mcpUrl,
        error: formatError(error),
      });
    }
  }

  throw new ExecutorUnavailableError(attempts);
}
import { errorMessage } from "../../utils/error-message.js";
