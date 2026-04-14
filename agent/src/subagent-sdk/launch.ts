import { toModeFlagName } from "../extensions/modes.js";
import type { TmuxTarget } from "../mode-utils.js";

import type { ChildBootstrapState, RuntimeSubagent } from "./types.js";

export type LaunchTarget = { kind: "session"; sessionPath: string } | { kind: "continue" };

export type LaunchCommandOptions = {
  launchTarget?: LaunchTarget;
  tmuxTarget: TmuxTarget;
  mode?: string;
  model?: string;
  thinkingLevel?: string;
  systemPrompt?: string;
  systemPromptMode: "append" | "replace";
};

export type LaunchCommandBuilder = (
  state: RuntimeSubagent,
  childState: ChildBootstrapState,
  prompt: string,
  options: LaunchCommandOptions,
) => string;

export const CHILD_STATE_ENV = "PI_SUBAGENT_CHILD_STATE";
export const PI_COMMAND_ENV = "PI_SUBAGENT_PI_COMMAND";

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function getPiCommandPrefix(): string[] {
  const override = process.env[PI_COMMAND_ENV]?.trim();
  if (override) {
    return [override];
  }

  const script = process.argv[1];
  if (!script) {
    return ["pi"];
  }

  const parts = [process.execPath, ...process.execArgv, script];
  return [parts.map((part) => shellEscape(part)).join(" ")];
}

export const buildLaunchCommand: LaunchCommandBuilder = (state, childState, prompt, options) => {
  const commandParts = [...getPiCommandPrefix()];
  const launchTarget: LaunchTarget = options.launchTarget ?? {
    kind: "session",
    sessionPath: state.sessionPath,
  };

  if (launchTarget.kind === "continue") {
    commandParts.push("--continue");
  } else {
    commandParts.push("--session", shellEscape(launchTarget.sessionPath));
  }

  if (options.model) {
    commandParts.push("--model", shellEscape(options.model));
  }
  if (options.thinkingLevel) {
    commandParts.push("--thinking", shellEscape(options.thinkingLevel));
  }
  if (options.systemPrompt) {
    commandParts.push(
      options.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt",
      shellEscape(options.systemPrompt),
    );
  }
  if (prompt.trim()) {
    commandParts.push(shellEscape(prompt));
  }
  if (options.mode) {
    const modeFlag = toModeFlagName(options.mode);
    if (modeFlag) {
      commandParts.push(`--${modeFlag}`);
    }
  }

  const envPayload = shellEscape(JSON.stringify(childState));
  return `env ${CHILD_STATE_ENV}=${envPayload} ${commandParts.join(" ")}`;
};

export function readChildState(): ChildBootstrapState | undefined {
  const raw = process.env[CHILD_STATE_ENV];
  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as ChildBootstrapState;
  } catch {
    return undefined;
  }
}
