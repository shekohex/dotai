import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isPhaseOverrideSubcommand, parseGsdCommandArgs } from "./args.js";
import { getGsdArgumentCompletions, getGsdSubcommands } from "./autocomplete.js";
import { gsdHandlers } from "./handlers.js";
import { getGsdSettings, saveGsdSettings } from "./settings.js";
import { showGsdHelp } from "./help.js";
import { rememberGsdCwd } from "./state/cwd.js";
import { showGsdDashboard } from "./ui.js";

export type GsdSubcommand =
  | "new-project"
  | "map-codebase"
  | "discuss-phase"
  | "plan-phase"
  | "execute-phase"
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

export function registerGsdCommands(pi: ExtensionAPI): void {
  pi.registerCommand("gsd", {
    description: "Get Shit Done: /gsd [subcommand]",
    getArgumentCompletions: (prefix) => getGsdArgumentCompletions(prefix),
    handler: async (args, ctx) => {
      rememberGsdCwd(ctx.cwd);
      const subcommand = parseSubcommand(args);
      const parsedArgs = parseGsdCommandArgs(args);
      const settings = getGsdSettings(ctx.cwd);
      if (subcommand === "on") {
        saveGsdSettings(ctx.cwd, { enabled: true });
        ctx.ui.notify("GSD enabled", "info");
        return;
      }
      if (subcommand === "off") {
        saveGsdSettings(ctx.cwd, { enabled: false });
        ctx.ui.notify("GSD disabled", "info");
        return;
      }
      if (!settings.enabled && subcommand !== "help" && subcommand !== "new-project") {
        ctx.ui.notify("GSD disabled. Run /gsd on.", "warning");
        return;
      }
      switch (subcommand) {
        case "new-project":
        case "map-codebase":
        case "discuss-phase":
        case "plan-phase":
        case "execute-phase":
        case "verify-work":
        case "validate-phase":
        case "next":
        case "progress":
        case "stats":
        case "health":
        case "status":
          await gsdHandlers[subcommand](
            pi,
            ctx,
            isPhaseOverrideSubcommand(subcommand) ? parsedArgs : {},
          );
          return;
        case "help":
          await showGsdHelp(ctx);
          return;
        case undefined:
          await showGsdDashboard(ctx);
      }
    },
  });
}
