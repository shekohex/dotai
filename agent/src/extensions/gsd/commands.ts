import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ensureInterviewToolEnabled } from "../interview/index.js";
import { parseGsdCommandArgs, usesParsedArgs } from "./args.js";
import { getGsdArgumentCompletions, getGsdSubcommands } from "./autocomplete.js";
import { gsdHandlers } from "./handlers.js";
import { getGsdSettings, saveGsdSettings } from "./settings.js";
import { syncBuiltInGsdModes } from "./modes.js";
import { showGsdHelp } from "./help.js";
import { rememberGsdCwd } from "./state/cwd.js";
import { showGsdDashboard } from "./ui.js";

const GSD_FLAG = "gsd";

const GSD_INTERVIEW_COMMANDS = new Set<GsdSubcommand>([
  "new-project",
  "new-milestone",
  "complete-milestone",
  "milestone-summary",
  "debug",
  "discuss-phase",
  "plan-phase",
  "execute-phase",
]);

export type GsdSubcommand =
  | "new-project"
  | "new-milestone"
  | "complete-milestone"
  | "milestone-summary"
  | "debug"
  | "map-codebase"
  | "discuss-phase"
  | "plan-phase"
  | "execute-phase"
  | "secure-phase"
  | "verify-work"
  | "validate-phase"
  | "next"
  | "progress"
  | "stats"
  | "health"
  | "status"
  | "help"
  | "on"
  | "off";

function parseSubcommand(args: string): GsdSubcommand | undefined {
  const parsed = parseGsdCommandArgs(args);
  return getGsdSubcommands().find((item) => item.value === parsed.subcommand)?.value;
}

function getRequestedSubcommand(args: string): string | undefined {
  return args
    .trim()
    .split(/\s+/u)
    .find((token) => token.length > 0);
}

function getUnexpectedArgument(args: string): string | undefined {
  return args
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 0)[1];
}

function shouldEnableInterviewForGsdCommand(
  subcommand: GsdSubcommand | undefined,
  parsedArgs: ReturnType<typeof parseGsdCommandArgs>,
): boolean {
  return (
    subcommand !== undefined && GSD_INTERVIEW_COMMANDS.has(subcommand) && parsedArgs.text !== true
  );
}

export function registerGsdCommands(pi: ExtensionAPI): void {
  pi.registerCommand("gsd", {
    description: "Get Shit Done: /gsd [subcommand]",
    getArgumentCompletions: (prefix) => getGsdArgumentCompletions(prefix),
    handler: async (args, ctx) => {
      rememberGsdCwd(ctx.cwd);
      const subcommand = parseSubcommand(args);
      const requestedSubcommand = getRequestedSubcommand(args);
      const unexpectedArgument = getUnexpectedArgument(args);
      const parsedArgs = parseGsdCommandArgs(args);
      const settings = getGsdSettings(ctx.cwd);
      if (subcommand === "on") {
        if (unexpectedArgument !== undefined) {
          ctx.ui.notify(`Unsupported /gsd on argument: ${unexpectedArgument}.`, "warning");
          return;
        }
        saveGsdSettings(ctx.cwd, { enabled: true });
        syncBuiltInGsdModes(true);
        ctx.ui.notify("GSD enabled", "info");
        return;
      }
      if (subcommand === "off") {
        if (unexpectedArgument !== undefined) {
          ctx.ui.notify(`Unsupported /gsd off argument: ${unexpectedArgument}.`, "warning");
          return;
        }
        saveGsdSettings(ctx.cwd, { enabled: false });
        syncBuiltInGsdModes(false);
        ctx.ui.notify("GSD disabled", "info");
        return;
      }
      if (
        !settings.enabled &&
        pi.getFlag(GSD_FLAG) !== true &&
        subcommand !== "help" &&
        subcommand !== "new-project" &&
        subcommand !== "new-milestone"
      ) {
        ctx.ui.notify("GSD disabled. Run /gsd on.", "warning");
        return;
      }
      switch (subcommand) {
        case "new-project":
        case "new-milestone":
        case "complete-milestone":
        case "milestone-summary":
        case "debug":
        case "map-codebase":
        case "discuss-phase":
        case "plan-phase":
        case "execute-phase":
        case "secure-phase":
        case "verify-work":
        case "validate-phase":
        case "next":
        case "progress":
        case "stats":
        case "health":
          if (shouldEnableInterviewForGsdCommand(subcommand, parsedArgs)) {
            ensureInterviewToolEnabled(pi);
          }
          await gsdHandlers[subcommand](
            pi,
            ctx,
            usesParsedArgs(subcommand) ? parsedArgs : {},
            args,
          );
          return;
        case "status":
          if (unexpectedArgument === undefined) {
            await gsdHandlers[subcommand](pi, ctx, {}, args);
          } else {
            ctx.ui.notify(`Unsupported /gsd status argument: ${unexpectedArgument}.`, "warning");
          }
          return;
        case "help":
          if (unexpectedArgument === undefined) {
            await showGsdHelp(pi, ctx);
          } else {
            ctx.ui.notify(`Unsupported /gsd help argument: ${unexpectedArgument}.`, "warning");
          }
          return;
        case undefined:
          if (requestedSubcommand === undefined) {
            await showGsdDashboard(ctx);
          } else {
            ctx.ui.notify(
              `Unsupported /gsd command: ${requestedSubcommand}. Run /gsd help.`,
              "warning",
            );
          }
      }
    },
  });
}
