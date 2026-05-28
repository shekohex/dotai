import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getShareState, formatStatusMessage } from "./state.js";
import { startTmuxShare, type TmuxShareHandle } from "./server.js";
import { getTmuxSessionInfo } from "./terminal.js";

const SUBCOMMANDS = [
  { value: "on", description: "Start sharing the current tmux window" },
  { value: "off", description: "Stop sharing" },
  { value: "status", description: "Show share status and URLs" },
] as const;

export default function tmuxShareExtension(pi: ExtensionAPI): void {
  let handle: TmuxShareHandle | null = null;

  const stopShare = async (ctx: Pick<ExtensionCommandContext, "ui">): Promise<void> => {
    if (!handle) {
      ctx.ui.notify("Tmux Share: not running", "info");
      return;
    }
    await handle.close();
    handle = null;
    ctx.ui.notify("Tmux Share: stopped", "info");
  };

  pi.on("session_shutdown", async () => {
    if (handle) {
      await handle.close();
      handle = null;
    }
  });

  pi.registerCommand("tmux-share", {
    description: "Share current tmux window over the web: /tmux-share [on|off|status]",
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.trim().toLowerCase();
      const items = SUBCOMMANDS.filter((s) => s.value.startsWith(normalized)).map((s) => ({
        value: s.value,
        label: s.value,
        description: s.description,
      }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim() || "status";

      if (action === "on") {
        if (handle) {
          const state = getShareState();
          if (state) {
            ctx.ui.notify(formatStatusMessage(state), "info");
          } else {
            ctx.ui.notify(
              "Tmux Share: already running but state lost, run /tmux-share off first",
              "warning",
            );
          }
          return;
        }

        if (!getTmuxSessionInfo()) {
          ctx.ui.notify("Tmux Share: not running inside a tmux session", "warning");
          return;
        }

        try {
          handle = await startTmuxShare({});
          const state = handle.state;
          ctx.ui.notify(formatStatusMessage(state), "info");
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          ctx.ui.notify(`Tmux Share failed: ${message}`, "error");
        }
        return;
      }

      if (action === "off") {
        await stopShare(ctx);
        return;
      }

      if (action !== "status") {
        ctx.ui.notify("Usage: /tmux-share <on|off|status>", "warning");
        return;
      }

      const state = getShareState();
      if (!state) {
        ctx.ui.notify("Tmux Share: stopped", "info");
        return;
      }
      ctx.ui.notify(formatStatusMessage(state), "info");
    },
  });
}
