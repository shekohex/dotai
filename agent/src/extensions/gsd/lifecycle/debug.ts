import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { isStaleSessionReplacementContextError } from "../../session-replacement.js";
import { errorMessage } from "../../../utils/error-message.js";
import type { GsdCommandArgs } from "../args.js";
import { listDebugSessions, resolveDebugSession } from "../state/debug.js";
import { launchGsdWorkflowSession } from "../workflow-launch.js";

function buildDebugSessionPrompt(
  cwd: string,
  args: GsdCommandArgs,
  commandArguments: string,
): string {
  if (args.debugAction === "continue" && args.slug !== undefined) {
    return [
      "Continue `/gsd debug` in this visible workflow session.",
      "",
      `<working_directory>${cwd}</working_directory>`,
      `<mode>gsd-debug-session-manager</mode>`,
      `<debug_action>continue</debug_action>`,
      `<slug>${args.slug}</slug>`,
      `<debug_file_path>${cwd}/.planning/debug/${args.slug}.md</debug_file_path>`,
      "",
      "Continue from existing debug file state. Orchestrate in this session. Delegate code investigation to `gsd-debugger` subagent when needed.",
    ].join("\n");
  }

  return [
    "Start `/gsd debug` in this visible workflow session.",
    "",
    `<working_directory>${cwd}</working_directory>`,
    `<mode>gsd-debug-session-manager</mode>`,
    `<debug_action>start</debug_action>`,
    `<goal>${args.diagnose === true ? "find_root_cause_only" : "find_and_fix"}</goal>`,
    `<command_arguments>${commandArguments}</command_arguments>`,
    "",
    "<user_report>",
    "DATA_START",
    args.description ?? "",
    "DATA_END",
    "</user_report>",
    "",
    "Mandatory behavior:",
    "- Use `interview` first for symptom intake in this visible workflow session before creating any debug file or spawning `gsd-debugger`.",
    "- Use the user report only as seed context. Do not skip structured intake for a new issue.",
    "- After intake, create `.planning/debug/{slug}.md`, then continue orchestration here.",
  ].join("\n");
}

function formatSession(session: ReturnType<typeof listDebugSessions>[number]): string {
  return `${session.slug} ${session.frontmatter.status} updated=${session.frontmatter.updated} hypothesis=${session.hypothesis ?? "unknown"} next=${session.nextAction ?? "unknown"}`;
}

function formatSessions(sessions: ReturnType<typeof listDebugSessions>): string {
  return sessions.map((session) => formatSession(session)).join("\n");
}

export async function handleGsdDebug(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: GsdCommandArgs,
): Promise<void> {
  if (args.debugAction === "list") {
    const sessions = listDebugSessions(ctx.cwd);
    ctx.ui.notify(
      sessions.length === 0
        ? "No active debug sessions. Run /gsd debug <issue description>"
        : `Active debug sessions\n${formatSessions(sessions)}`,
      "info",
    );
    return;
  }

  if (args.debugAction === "status") {
    if (args.slug === undefined) {
      ctx.ui.notify("Missing debug session slug", "warning");
      return;
    }
    const session = resolveDebugSession(ctx.cwd, args.slug);
    ctx.ui.notify(
      session === undefined
        ? `No debug session found with slug: ${args.slug}`
        : `Debug session ${session.slug}\nstatus=${session.frontmatter.status}\nhypothesis=${session.hypothesis ?? "unknown"}\nnext=${session.nextAction ?? "unknown"}\nevidence=${session.evidenceCount}\neliminated=${session.eliminatedCount}`,
      session === undefined ? "warning" : "info",
    );
    return;
  }

  const commandArguments = buildDebugCommandArguments(args);

  try {
    await launchGsdWorkflowSession(pi, ctx, {
      promptOverride: buildDebugSessionPrompt(ctx.cwd, args, commandArguments),
      commandName: "debug",
      commandArguments,
      mode: "gsd-debug-session-manager",
      sessionStrategy: "new",
      commandResourcePath: "commands/gsd/debug.md",
      extraResourcePaths: [
        "agents/gsd-debug-session-manager.md",
        "agents/gsd-debugger.md",
        "references/debugger-philosophy.md",
        "references/common-bug-patterns.md",
      ],
      extraInstructions:
        args.debugAction === "continue" && args.slug !== undefined
          ? [
              `Resume existing debug session slug: ${args.slug}`,
              `Existing session file: ${ctx.cwd}/.planning/debug/${args.slug}.md`,
              "Use visible workflow session for user interaction. Spawn gsd-debugger only after any needed intake is complete.",
            ]
          : [
              "Use visible workflow session and run debug intake there.",
              "Use `interview` for structured intake before creating any debug session file or spawning gsd-debugger.",
              "Use model judgment inside workflow to derive slug and create the debug session file. Do not rely on TypeScript-side slug generation or template scaffolding.",
              "Visible workflow session should orchestrate; delegated code investigation should run in gsd-debugger subagent.",
              "Do not mention legacy gsd-sdk commands unless you are explicitly using bundled compatibility helper behavior.",
            ],
    });
  } catch (error) {
    if (!isStaleSessionReplacementContextError(error)) {
      ctx.ui.notify(`GSD debug launch failed: ${errorMessage(error)}`, "error");
    }
    throw error;
  }
}

function buildDebugCommandArguments(args: GsdCommandArgs): string {
  if (args.debugAction === "list") {
    return "list";
  }
  if (args.debugAction === "status") {
    return `status ${args.slug ?? ""}`.trim();
  }
  if (args.debugAction === "continue") {
    return `continue ${args.slug ?? ""}`.trim();
  }
  const flags = args.diagnose === true ? ["--diagnose"] : [];
  if (args.description !== undefined) {
    flags.push(args.description);
  }
  return flags.join(" ").trim();
}
