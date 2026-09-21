import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../runtime.js";
import { runStatusCommand } from "./status.js";
import { runViewCommand } from "./view.js";

const USAGE_TEXT = "Usage: /om status | /om view [full]";

export function registerOmCommand(pi: ExtensionAPI, runtime: Runtime): void {
  pi.registerCommand("om", {
    description: "Observational memory: show status or print/copy recorded session memory",
    getArgumentCompletions(prefix) {
      const items = [
        {
          value: "status",
          label: "status",
          description: "Ledger counts, token progress, drift, and worker state",
        },
        {
          value: "view",
          label: "view",
          description: "Print and copy visible memory (what the agent last saw)",
        },
        {
          value: "view full",
          label: "view full",
          description: "Print and copy the full recorded branch memory",
        },
      ];
      const trimmed = prefix.trim().toLowerCase();
      const filtered = items.filter((item) => item.value.startsWith(trimmed));
      return filtered.length > 0 ? filtered : items;
    },
    handler: async (args, ctx) => {
      const [subcommand, ...rest] = args.trim().split(/\s+/);
      if (subcommand === "status") {
        runStatusCommand(runtime, ctx);
        return;
      }
      if (subcommand === "view") {
        await runViewCommand(runtime, rest.join(" "), ctx);
        return;
      }
      ctx.ui.notify(USAGE_TEXT, "info");
    },
  });
}
