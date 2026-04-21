import { isAutoExitTimeoutModeActive } from "../persistence.js";
import type { ChildBootstrapState, RuntimeSubagent } from "../types.js";
import type { ResolvedModeValue } from "./base.js";

export function buildResumeStateBundle(input: {
  existing: RuntimeSubagent;
  mode: ResolvedModeValue;
  task: string;
  parentSessionId: string;
  parentSessionPath: string | undefined;
  resumedAt: number;
}): { childState: ChildBootstrapState; provisionalState: RuntimeSubagent } {
  return {
    childState: {
      sessionId: input.existing.sessionId,
      sessionPath: input.existing.sessionPath,
      parentSessionId: input.parentSessionId,
      parentSessionPath: input.parentSessionPath,
      name: input.existing.name,
      prompt: input.task,
      mode: input.mode.modeName,
      autoExit: input.mode.autoExit,
      autoExitTimeoutMs: input.mode.autoExitTimeoutMs,
      handoff: false,
      tools: input.mode.tools,
      outputFormat: input.existing.outputFormat,
      startedAt: input.existing.startedAt,
    },
    provisionalState: {
      ...input.existing,
      event: "resumed",
      parentSessionId: input.parentSessionId,
      parentSessionPath: input.parentSessionPath,
      mode: input.mode.modeName,
      modeLabel: input.mode.modeName,
      cwd: input.mode.cwd,
      paneId: "",
      task: input.task,
      handoff: false,
      autoExit: input.mode.autoExit,
      autoExitTimeoutMs: input.mode.autoExitTimeoutMs,
      autoExitTimeoutActive:
        input.existing.autoExitTimeoutActive ??
        isAutoExitTimeoutModeActive(input.existing.sessionId),
      status: "running",
      summary: undefined,
      structured: undefined,
      structuredError: undefined,
      exitCode: undefined,
      updatedAt: input.resumedAt,
      completedAt: undefined,
    },
  };
}
