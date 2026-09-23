import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Runtime } from "../runtime.js";
import { runStatusCommand } from "./status.js";
import { runViewCommand } from "./view.js";

const USAGE_TEXT = "Usage: /om status | /om view [full] | /om toggle";
const OM_ENABLED_ENTRY = "om.enabled";
const OmEnabledEntrySchema = Type.Object({ enabled: Type.Boolean() });

export function registerOmCommand(pi: ExtensionAPI, runtime: Runtime): void {
  pi.registerCommand("om", {
    description: "Observational memory: show status or print/copy recorded session memory",
    getArgumentCompletions(prefix) {
      const items = [
        { value: "toggle", label: "toggle", description: "Enable or disable observational memory" },
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
      if (subcommand === "toggle" && rest.length === 0) {
        runtime.ensureConfig(ctx.cwd);
        runtime.config.enabled = !runtime.config.enabled;
        pi.appendEntry(OM_ENABLED_ENTRY, { enabled: runtime.config.enabled });
        ctx.ui.notify(
          `Observational memory ${runtime.config.enabled ? "enabled" : "disabled"}`,
          "info",
        );
        return;
      }
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

  pi.on("session_start", (_event, ctx) => {
    runtime.ensureConfig(ctx.cwd);
    const latest = ctx.sessionManager
      .getBranch()
      .toReversed()
      .find((entry) => entry.type === "custom" && entry.customType === OM_ENABLED_ENTRY);
    if (latest?.type !== "custom" || !Value.Check(OmEnabledEntrySchema, latest.data)) return;
    runtime.config.enabled = Value.Parse(OmEnabledEntrySchema, latest.data).enabled;
  });
}
