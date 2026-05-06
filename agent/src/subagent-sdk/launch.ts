import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TmuxTarget } from "../mode-utils.js";
import { errorMessage } from "../utils/error-message.js";

import {
  parseChildBootstrapState,
  type ChildBootstrapState,
  type RuntimeSubagent,
} from "./types.js";

export type LaunchTarget =
  | { kind: "session"; sessionPath: string }
  | { kind: "continue" }
  | { kind: "ephemeral" };

export type LaunchCommandOptions = {
  launchTarget?: LaunchTarget;
  tmuxTarget: TmuxTarget;
  model?: string;
  thinkingLevel?: string;
  systemPrompt?: string;
  systemPromptMode: "append" | "replace";
  modeName?: string;
};

export type LaunchCommandBuilder = (
  state: RuntimeSubagent,
  childState: ChildBootstrapState,
  prompt: string,
  options: LaunchCommandOptions,
) => string;

export const CHILD_STATE_ENV = "PI_SUBAGENT_CHILD_STATE";
export const PI_COMMAND_ENV = "PI_SUBAGENT_PI_COMMAND";
export const CHILD_STATE_FILE_ENV = "PI_SUBAGENT_CHILD_STATE_FILE";
const SYSTEM_PROMPT_FILE_ENV = "PI_SUBAGENT_SYSTEM_PROMPT_FILE";
const TASK_FILE_ENV = "PI_SUBAGENT_TASK_FILE";
const SUBAGENT_ENV_ALLOWLIST = [
  "PI_DEBUG_PROVIDER_REQUESTS",
  "PI_DEBUG_SYSTEM_PROMPT",
  "PI_DEBUG_PROVIDER_REQUESTS_LOG",
] as const;

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function getPiCommandPrefix(): string[] {
  const override = process.env[PI_COMMAND_ENV]?.trim();
  if (override !== undefined && override.length > 0) {
    return [override];
  }

  const script = process.argv[1];
  if (!script) {
    return ["pi"];
  }

  const parts = [process.execPath, ...process.execArgv, script];
  return [parts.map((part) => shellEscape(part)).join(" ")];
}

function modeFlagName(modeName: string): string {
  return `mode-${modeName
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036F]/g, "")
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")}`;
}

function buildFileBackedArgument(
  value: string,
  envName: string,
): {
  envAssignment: string;
  shellExpression: string;
} {
  const filePath = path.join(
    os.tmpdir(),
    `${envName.toLowerCase()}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );
  fs.writeFileSync(filePath, value, "utf8");
  return {
    envAssignment: `${envName}=${shellEscape(filePath)}`,
    shellExpression: `"$(cat "$${envName}")"`,
  };
}

export const buildLaunchCommand: LaunchCommandBuilder = (state, childState, prompt, options) => {
  const commandParts = [...getPiCommandPrefix()];
  const childStateArgument = buildFileBackedArgument(
    JSON.stringify(childState),
    CHILD_STATE_FILE_ENV,
  );
  const envAssignments = [childStateArgument.envAssignment];
  for (const envName of SUBAGENT_ENV_ALLOWLIST) {
    const envValue = process.env[envName]?.trim();
    if (envValue !== undefined && envValue.length > 0) {
      envAssignments.push(`${envName}=${shellEscape(envValue)}`);
    }
  }
  const persistedSessionPath =
    state.persisted !== false && state.sessionPath !== undefined && state.sessionPath.length > 0
      ? state.sessionPath
      : undefined;
  const hasPersistedSessionPath = persistedSessionPath !== undefined;
  const launchTarget: LaunchTarget =
    options.launchTarget ??
    (hasPersistedSessionPath
      ? {
          kind: "session",
          sessionPath: persistedSessionPath,
        }
      : { kind: "ephemeral" });

  if (launchTarget.kind === "continue") {
    commandParts.push("--continue");
  } else if (launchTarget.kind === "ephemeral") {
    commandParts.push("--no-session");
  } else {
    commandParts.push("--session", shellEscape(launchTarget.sessionPath));
  }

  if (options.model !== undefined && options.model.length > 0) {
    commandParts.push("--model", shellEscape(options.model));
  }
  if (options.thinkingLevel !== undefined && options.thinkingLevel.length > 0) {
    commandParts.push("--thinking", shellEscape(options.thinkingLevel));
  }
  if (options.modeName !== undefined && options.modeName.length > 0) {
    commandParts.push(`--${modeFlagName(options.modeName)}=true`);
  } else if (options.systemPrompt !== undefined && options.systemPrompt.length > 0) {
    const systemPromptArgument = buildFileBackedArgument(
      options.systemPrompt,
      SYSTEM_PROMPT_FILE_ENV,
    );
    envAssignments.push(systemPromptArgument.envAssignment);
    commandParts.push(
      options.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt",
      systemPromptArgument.shellExpression,
    );
  }
  if (prompt.trim().length > 0) {
    const taskArgument = buildFileBackedArgument(prompt, TASK_FILE_ENV);
    envAssignments.push(taskArgument.envAssignment);
    commandParts.push(taskArgument.shellExpression);
  }
  return `export ${envAssignments.join(" ")}; ${commandParts.join(" ")}`;
};

export function readChildState(options?: {
  strictFile?: boolean;
}): ChildBootstrapState | undefined {
  const raw = process.env[CHILD_STATE_ENV];
  if (raw !== undefined && raw.length > 0) {
    try {
      return parseChildBootstrapState(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }

  const filePath = process.env[CHILD_STATE_FILE_ENV];
  if (filePath !== undefined && filePath.length > 0) {
    try {
      const parsed = parseChildBootstrapState(JSON.parse(fs.readFileSync(filePath, "utf8")));
      if (parsed === undefined) {
        throw new Error(`Invalid child bootstrap state in ${filePath}`);
      }
      return parsed;
    } catch (error) {
      if (options?.strictFile !== true) {
        return undefined;
      }
      throw new Error(
        `Failed to load child bootstrap state from ${filePath}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  return undefined;
}

export const SUBAGENT_DEBUG_ENV_ALLOWLIST = SUBAGENT_ENV_ALLOWLIST;
