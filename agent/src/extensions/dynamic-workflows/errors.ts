/** Workflow-specific error types. */

export enum WorkflowErrorCode {
  /** Agent exceeded timeout. */
  AGENT_TIMEOUT = "AGENT_TIMEOUT",
  /** Workflow was aborted by user. */
  WORKFLOW_ABORTED = "WORKFLOW_ABORTED",
  /** Agent limit exceeded. */
  AGENT_LIMIT_EXCEEDED = "AGENT_LIMIT_EXCEEDED",
  /** Token budget exhausted. */
  TOKEN_BUDGET_EXHAUSTED = "TOKEN_BUDGET_EXHAUSTED",
  /** Script validation failed. */
  SCRIPT_VALIDATION_ERROR = "SCRIPT_VALIDATION_ERROR",
  /** Agent execution failed. */
  AGENT_EXECUTION_ERROR = "AGENT_EXECUTION_ERROR",
  /** Run state persistence failed. */
  PERSISTENCE_ERROR = "PERSISTENCE_ERROR",
  /** Unknown error. */
  UNKNOWN = "UNKNOWN",
}

export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  readonly recoverable: boolean;
  readonly agentLabel?: string;
  readonly details?: unknown;

  constructor(
    message: string,
    code: WorkflowErrorCode,
    options: { recoverable?: boolean; agentLabel?: string; details?: unknown } = {},
  ) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    this.recoverable = options.recoverable ?? false;
    this.agentLabel = options.agentLabel;
    this.details = options.details;
  }
}

export function isWorkflowError(error: unknown): error is WorkflowError {
  return error instanceof WorkflowError;
}

export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /\babort(?:ed)?\b/i.test(error.message);
}

export function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /\btimeout\b/i.test(error.message) || error.name === "TimeoutError";
}

export function isRetryableErrorMessage(message: string): boolean {
  return /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay|\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND)\b/i.test(
    message,
  );
}

export function isRetryableWorkflowError(error: WorkflowError): boolean {
  if (error.code === WorkflowErrorCode.AGENT_TIMEOUT) return true;
  if (error.code === WorkflowErrorCode.WORKFLOW_ABORTED) return false;
  if (error.code !== WorkflowErrorCode.AGENT_EXECUTION_ERROR) return false;
  return isRetryableErrorMessage(error.message);
}

export function parseWorkflowErrorCode(value: string | undefined): WorkflowErrorCode {
  if (value === WorkflowErrorCode.AGENT_TIMEOUT) return WorkflowErrorCode.AGENT_TIMEOUT;
  if (value === WorkflowErrorCode.WORKFLOW_ABORTED) return WorkflowErrorCode.WORKFLOW_ABORTED;
  if (value === WorkflowErrorCode.AGENT_LIMIT_EXCEEDED)
    return WorkflowErrorCode.AGENT_LIMIT_EXCEEDED;
  if (value === WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED)
    return WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED;
  if (value === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR)
    return WorkflowErrorCode.SCRIPT_VALIDATION_ERROR;
  if (value === WorkflowErrorCode.AGENT_EXECUTION_ERROR)
    return WorkflowErrorCode.AGENT_EXECUTION_ERROR;
  if (value === WorkflowErrorCode.PERSISTENCE_ERROR) return WorkflowErrorCode.PERSISTENCE_ERROR;
  return WorkflowErrorCode.UNKNOWN;
}

export function errorMessage(error: unknown, fallback?: string): string {
  if (error instanceof Error) return error.message;
  return fallback ?? String(error);
}

/**
 * Wrap an unknown error into a WorkflowError with appropriate classification.
 *
 * @param {unknown} error Error to wrap.
 * @param {{ agentLabel?: string }} context Optional workflow context.
 * @returns {WorkflowError} Workflow-specific error.
 */
export function wrapError(error: unknown, context?: { agentLabel?: string }): WorkflowError {
  if (isWorkflowError(error)) return error;

  if (isAbortError(error)) {
    return new WorkflowError(
      errorMessage(error, "Workflow was aborted"),
      WorkflowErrorCode.WORKFLOW_ABORTED,
      { recoverable: false },
    );
  }

  if (isTimeoutError(error)) {
    return new WorkflowError(
      errorMessage(error, "Agent timed out"),
      WorkflowErrorCode.AGENT_TIMEOUT,
      { recoverable: true, agentLabel: context?.agentLabel },
    );
  }

  return new WorkflowError(errorMessage(error), WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
    recoverable: true,
    agentLabel: context?.agentLabel,
    details: error,
  });
}
