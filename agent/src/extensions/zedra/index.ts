import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { Value } from "typebox/value";
import { isAskUserQuestionEventPayload } from "../ask-user-question/events.js";
import {
  ASK_USER_QUESTION_ANSWERED_EVENT,
  ASK_USER_QUESTION_CANCELLED_EVENT,
  ASK_USER_QUESTION_PROMPT_EVENT,
} from "../ask-user-question/index.js";
import { GOAL_BLOCKED_EVENT, GoalBlockedEventSchema } from "../goal/types.js";
import { isChildSession, readChildState } from "../../subagent-sdk/index.js";

export interface ZedraHookPayload {
  hook_event_name: string;
  session_id: string;
}

export interface ZedraHookProcess {
  on(event: "error", listener: () => void): void;
  stdin: { on(event: "error", listener: () => void): void; end(data: string): void } | null;
  unref(): void;
}

// Spyable process seam, mirroring terminalNotifyRuntime.
export const zedraHookRuntime = {
  spawn: (
    command: string,
    args: string[],
    options: { stdio: ["pipe", "ignore", "ignore"]; detached: boolean },
  ): ZedraHookProcess => spawn(command, args, options),
};

export interface ZedraExtensionRuntime {
  readTerminalId(): string | undefined;
  readCli(): string;
  sendHook(cli: string, payload: ZedraHookPayload): void;
}

export const defaultZedraExtensionRuntime: ZedraExtensionRuntime = {
  readTerminalId: () => process.env.ZEDRA_TERMINAL_ID,
  readCli: () => process.env.ZEDRA_CLI ?? "zedra",
  sendHook: (cli, payload) => {
    try {
      const child = zedraHookRuntime.spawn(
        cli,
        ["agent", "hook", "receive", "--agent", "pi", "--quiet"],
        {
          stdio: ["pipe", "ignore", "ignore"],
          detached: true,
          // ZEDRA_TERMINAL_ID and ZEDRA_WORKDIR are inherited from process.env
          // and picked up by `agent hook receive` as --terminal-id / --workdir.
        },
      );
      child.on("error", () => {});
      child.stdin?.on("error", () => {});
      child.stdin?.end(JSON.stringify(payload));
      child.unref();
    } catch {
      // spawn() can throw synchronously (EACCES, ENOENT). Stay silent.
    }
  },
};

export const createZedraExtension = (
  runtime: ZedraExtensionRuntime = defaultZedraExtensionRuntime,
) =>
  function zedraExtension(pi: ExtensionAPI): void {
    if (runtime.readTerminalId() === undefined) return;

    const cli = runtime.readCli();
    const childState = readChildState();
    let running = false;
    let currentContext: ExtensionContext | null = null;

    // Pi lifecycle events carry no sessionId; the daemon needs it to key agent
    // state per session and to fill the Stop notification body (session title).
    const fire = (hookEventName: string, ctx: ExtensionContext): void => {
      try {
        runtime.sendHook(cli, {
          hook_event_name: hookEventName,
          session_id: ctx.sessionManager.getSessionId(),
        });
      } catch {
        // A custom runtime seam may throw synchronously. Stay silent.
      }
    };

    // Gate on ctx.hasUI: skip non-interactive (print / JSON) runs, and on
    // subagent child sessions, which run with bundled extensions bound (rpc
    // mode has UI) and must not drive Zedra state or pushes.
    const skip = (ctx: ExtensionContext) => !ctx.hasUI || isChildSession(childState, ctx);

    const accept = (ctx: ExtensionContext): boolean => {
      if (skip(ctx)) return false;
      currentContext = ctx;
      return true;
    };

    pi.on("before_agent_start", (_event, ctx) => {
      if (!accept(ctx)) return;
      running = true;
      fire("UserPromptSubmit", ctx);
    });

    // No state change on the daemon for pi; forwarded raw to the phone app.
    pi.on("tool_execution_end", (_event, ctx) => {
      if (!accept(ctx)) return;
      fire("PostToolUse", ctx);
    });

    // agent_end fires per low-level run while pi may still auto-retry,
    // auto-compact, or run queued follow-ups (goal continuations). Only
    // agent_settled is the true turn boundary, so Stop (Zedra Completed state
    // plus the "Pi completed" push) must wait for it.
    pi.on("agent_settled", (_event, ctx) => {
      if (!accept(ctx) || !running) return;
      running = false;
      fire("Stop", ctx);
    });

    // Fires on Ctrl+C, SIGTERM, /quit, /reload, /new, /resume, /fork. Only a
    // mid-turn shutdown clears the Zedra Running indicator; an idle switch
    // would otherwise emit a spurious "Pi completed" push.
    pi.on("session_shutdown", (_event, ctx) => {
      if (skip(ctx) || !running) return;
      running = false;
      fire("Stop", ctx);
    });

    // The daemon's pi actor ignores PermissionRequest today (no approval hook
    // upstream); firing it on agent-blocking prompts is forward-compatible —
    // once Zedra maps it, WaitingApproval + "requires approval" push work with
    // no extension change. Answered/cancelled prompts restore Running via
    // PostToolUse on the generic daemon map.
    pi.events.on(ASK_USER_QUESTION_PROMPT_EVENT, (data) => {
      if (currentContext === null || !isAskUserQuestionEventPayload(data)) return;
      fire("PermissionRequest", currentContext);
    });

    pi.events.on(ASK_USER_QUESTION_ANSWERED_EVENT, (data) => {
      if (currentContext === null || !isAskUserQuestionEventPayload(data)) return;
      fire("PostToolUse", currentContext);
    });

    pi.events.on(ASK_USER_QUESTION_CANCELLED_EVENT, (data) => {
      if (currentContext === null || !isAskUserQuestionEventPayload(data)) return;
      fire("PostToolUse", currentContext);
    });

    pi.events.on(GOAL_BLOCKED_EVENT, (data) => {
      if (currentContext === null || !Value.Check(GoalBlockedEventSchema, data)) return;
      fire("PermissionRequest", currentContext);
    });
  };

export default createZedraExtension();
