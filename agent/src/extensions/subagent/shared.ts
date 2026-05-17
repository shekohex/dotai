import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MuxAdapter } from "../../subagent-sdk/mux.js";
import type { RuntimeSubagent, SubagentToolParams, TSchemaBase } from "../../subagent-sdk/types.js";

type CreateSubagentExtensionOptions = {
  adapterFactory?: (pi: ExtensionAPI) => MuxAdapter;
  enabled?: boolean;
};

type SubagentRuntimeState = {
  ctx?: ExtensionContext;
  toolPromptSignature?: string;
};

type SubagentRenderState = {
  startedAt?: number;
  endedAt?: number;
  interval?: ReturnType<typeof setInterval>;
  callComponent?: unknown;
  callText?: string;
};

type SubagentStartValue = {
  prompt: string;
  handle: {
    getState: () => RuntimeSubagent;
  };
  state?: RuntimeSubagent;
  structured?: unknown;
};

const SUBAGENT_STREAM_PREVIEW_LINE_LIMIT = 5;
const SUBAGENT_STREAM_PREVIEW_WIDTH = 96;

function ensureParentSubagentToolActive(pi: ExtensionAPI): void {
  const activeTools = new Set([...pi.getActiveTools(), "subagent"]);
  pi.setActiveTools(Array.from(activeTools).toSorted((left, right) => left.localeCompare(right)));
}

function scheduleParentSubagentToolActivation(pi: ExtensionAPI): void {
  const activate = () => {
    try {
      ensureParentSubagentToolActive(pi);
    } catch {}
  };
  queueMicrotask(activate);
  const timer = setTimeout(activate, 0);
  timer.unref?.();
}

function validateToolParams(params: SubagentToolParams): void {
  if (params.action === "start") {
    if ((params.name?.trim().length ?? 0) === 0) {
      throw new Error(
        "Invalid subagent start params: `name` is required. It becomes the child terminal title when the backend supports titles.",
      );
    }
    if ((params.task?.trim().length ?? 0) === 0) {
      throw new Error(
        "Invalid subagent start params: `task` is required. There is no subagent read action later, so provide the delegated work up front and inspect backend terminal output only when available and needed.",
      );
    }
    if (params.outputFormat?.type === "json_schema" && params.outputFormat.schema === undefined) {
      throw new Error(
        "Invalid subagent start params: `outputFormat.schema` is required when `outputFormat.type` is `json_schema`.",
      );
    }
  }

  if (params.action === "message") {
    if ((params.sessionId?.trim().length ?? 0) === 0) {
      throw new Error(
        "Invalid subagent message params: `sessionId` is required. Use `subagent` `list` or a prior subagent result to choose the full UUID v4 sessionId.",
      );
    }
    if ((params.message?.trim().length ?? 0) === 0) {
      throw new Error(
        "Invalid subagent message params: `message` is required. This text is sent into the child terminal.",
      );
    }
  }

  if (params.action === "cancel" && (params.sessionId?.trim().length ?? 0) === 0) {
    throw new Error(
      "Invalid subagent cancel params: `sessionId` is required. Use `subagent` `list` or a prior subagent result to choose the full UUID v4 sessionId.",
    );
  }
}

function normalizeSubagentExecutionError(
  action: SubagentToolParams["action"],
  error: unknown,
): Error {
  const message = errorMessage(error);
  if (message.startsWith("Invalid subagent ") || message.startsWith(`subagent ${action} failed:`)) {
    return error instanceof Error ? error : new Error(message);
  }
  return new Error(`subagent ${action} failed: ${message}`);
}

function getStartGuidanceText(): string {
  return "This is the prompt sent to the child session. The subagent will return with a summary automatically when it finishes, so usually continue doing your work that needs to be done or wait for completion instead of polling with list or checking repeatedly for the final result. Use message only to steer the work, cancel to stop it, and inspect backend terminal output only when available and needed.";
}

function formatStartResultText(state: RuntimeSubagent): string {
  const ephemeralHint =
    state.persisted === false
      ? " This subagent is ephemeral (persisted: false). You can message it while running, but once it finishes it cannot be resumed. Start a new subagent for follow-up work."
      : "";
  return `Subagent ${state.name} started and is running in the background. sessionId: ${state.sessionId}. It will return with a summary automatically when it finishes, so continue your other work and wait for its completion summary. Do not poll with list or check repeatedly for results. Use subagent message only to steer the work while running, cancel to stop it, and inspect backend terminal output only when available and needed.${ephemeralHint}`;
}

function formatStructuredStartResultText(state: RuntimeSubagent): string {
  const ephemeralHint =
    state.persisted === false
      ? " This subagent was ephemeral (persisted: false). Once it exits it cannot be resumed. Start a new subagent if you need to run again."
      : "";
  return `Subagent ${state.name} completed with structured output. sessionId: ${state.sessionId}.${ephemeralHint}`;
}

function serializeStructuredStartContent(structured: unknown): string {
  try {
    const serialized = JSON.stringify(structured);
    return serialized ?? "null";
  } catch {
    if (
      structured === undefined ||
      typeof structured === "string" ||
      typeof structured === "number" ||
      typeof structured === "boolean"
    ) {
      return formatScalarValue(structured);
    }
    return formatScalarValue();
  }
}

function formatAutoResumedMessageResultText(state: RuntimeSubagent, _delivery: string): string {
  return `Subagent ${state.name} was completed. Resumed with new task. sessionId: ${state.sessionId}.`;
}

function formatMessageResultText(state: RuntimeSubagent, delivery: string): string {
  const ephemeralHint =
    state.persisted === false
      ? " This subagent is ephemeral (persisted: false) — once it finishes it cannot be messaged or resumed."
      : "";
  return `Subagent ${state.name} message delivered. sessionId: ${state.sessionId}. delivery: ${delivery}.${ephemeralHint}`;
}

function formatCancelResultText(state: RuntimeSubagent): string {
  return `Subagent ${state.name} cancelled. sessionId: ${state.sessionId}.`;
}

function formatListResultText(subagents: RuntimeSubagent[]): string {
  if (subagents.length === 0) {
    return "No subagents.";
  }
  return [
    `count: ${subagents.length}`,
    ...subagents.map(
      (subagent, index) =>
        `${index + 1}. ${subagent.name} · ${subagent.status} · sessionId: ${subagent.sessionId} · ${summarizeWhitespace(subagent.task, 48)}`,
    ),
  ].join("\n");
}

function summarizeTask(task?: string, maxLength = 56): string {
  const normalized = (task ?? "").replaceAll(/\s+/g, " ").trim();
  if (!normalized) {
    return "...";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function shortSessionId(sessionId?: string): string {
  const value = sessionId?.trim();
  if (value === undefined || value.length === 0) {
    return "...";
  }
  return value.slice(0, 8);
}

function summarizeWhitespace(value?: string, maxLength = 56): string {
  return summarizeTask(value, maxLength);
}

function isSubagentRenderState(value: unknown): value is SubagentRenderState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const startedAt = "startedAt" in value ? value.startedAt : undefined;
  const endedAt = "endedAt" in value ? value.endedAt : undefined;
  const interval = "interval" in value ? value.interval : undefined;

  const startedAtValid = startedAt === undefined || typeof startedAt === "number";
  const endedAtValid = endedAt === undefined || typeof endedAt === "number";
  const intervalValid = interval === undefined || interval instanceof Object;
  return startedAtValid && endedAtValid && intervalValid;
}

function isTypeboxSchema(value: unknown): value is TSchemaBase {
  return value !== null && typeof value === "object";
}

function isRuntimeSubagent(value: unknown): value is RuntimeSubagent {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "sessionId" in value &&
    typeof value.sessionId === "string" &&
    "name" in value &&
    typeof value.name === "string" &&
    "status" in value &&
    typeof value.status === "string" &&
    "task" in value &&
    typeof value.task === "string"
  );
}

function formatScalarValue(value?: string | number | boolean): string {
  if (value === undefined) {
    return "-";
  }
  const text = String(value).trim();
  return text.length > 0 ? text : "-";
}

export {
  ensureParentSubagentToolActive,
  formatAutoResumedMessageResultText,
  formatCancelResultText,
  formatListResultText,
  formatMessageResultText,
  formatScalarValue,
  formatStartResultText,
  formatStructuredStartResultText,
  getStartGuidanceText,
  isRuntimeSubagent,
  isSubagentRenderState,
  isTypeboxSchema,
  normalizeSubagentExecutionError,
  scheduleParentSubagentToolActivation,
  serializeStructuredStartContent,
  shortSessionId,
  summarizeTask,
  summarizeWhitespace,
  validateToolParams,
  SUBAGENT_STREAM_PREVIEW_LINE_LIMIT,
  SUBAGENT_STREAM_PREVIEW_WIDTH,
};
export type {
  CreateSubagentExtensionOptions,
  SubagentRenderState,
  SubagentRuntimeState,
  SubagentStartValue,
};
import { errorMessage } from "../../utils/error-message.js";
