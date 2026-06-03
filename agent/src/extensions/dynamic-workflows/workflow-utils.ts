import { createHash } from "node:crypto";
import { WorkflowError, WorkflowErrorCode, wrapError } from "./errors.js";
import type { AgentOptions, WorkflowExecution, WorkflowRunOptions } from "./workflow.js";

export function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit)
      await new Promise<void>((resolve) => {
        queue.push(resolve);
      });
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

export function defaultAgentLabel(phase: string | undefined, index: number): string {
  return phase !== undefined && phase !== "" ? `${phase} agent ${index}` : `agent ${index}`;
}

export function hashAgentCall(
  prompt: string,
  mode: string | undefined,
  phase: string | undefined,
  options: AgentOptions,
): string {
  const identity = JSON.stringify({
    prompt,
    mode: mode ?? null,
    phase: phase ?? null,
    agentType: options.agentType ?? null,
    outputRetryCount: options.outputRetryCount ?? null,
    toolNames: options.toolNames ?? null,
    schema: options.schema ?? null,
  });
  return createHash("sha256").update(identity).digest("hex");
}

export function buildAgentInstructions(
  phase: string | undefined,
  options: AgentOptions,
): string | undefined {
  const lines = [];
  if (phase !== undefined && phase !== "") lines.push(`Workflow phase: ${phase}`);
  if (options.agentType !== undefined && options.agentType !== "")
    lines.push(`Act as workflow subagent type: ${options.agentType}`);
  if (options.isolation !== undefined) lines.push(`Requested isolation: ${options.isolation}`);
  return lines.length > 0 ? lines.join("\n") : undefined;
}

export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? "").length / 4);
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new WorkflowError(message, WorkflowErrorCode.AGENT_TIMEOUT, { recoverable: true }));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export function createParallelFunction(execution: WorkflowExecution, options: WorkflowRunOptions) {
  return (thunks: Array<() => Promise<unknown>>) => {
    execution.throwIfAborted();
    if (thunks.some((thunk) => typeof thunk !== "function")) {
      throw new TypeError(
        "parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)",
      );
    }
    return Promise.all(
      thunks.map(async (thunk, index) => {
        try {
          return await thunk();
        } catch (error) {
          if (options.signal?.aborted === true) throw error;
          const workflowError = wrapError(error);
          execution.log(`parallel[${index}] failed: ${workflowError.message}`);
          return null;
        }
      }),
    );
  };
}

export function createPipelineFunction(execution: WorkflowExecution, options: WorkflowRunOptions) {
  return (
    items: unknown[],
    ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
  ) => {
    execution.throwIfAborted();
    if (stages.some((stage) => typeof stage !== "function")) {
      throw new TypeError(
        "pipeline() stages must be functions: pipeline(items, item => ..., result => ...)",
      );
    }
    return Promise.all(
      items.map(async (item, index) => {
        let value: unknown = item;
        for (const stage of stages) {
          try {
            execution.throwIfAborted();
            value = await stage(value, item, index);
            execution.throwIfAborted();
          } catch (error) {
            if (options.signal?.aborted === true) throw error;
            const workflowError = wrapError(error);
            execution.log(`pipeline[${index}] failed: ${workflowError.message}`);
            return null;
          }
        }
        return value;
      }),
    );
  };
}
