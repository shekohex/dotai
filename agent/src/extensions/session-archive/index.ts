import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSessionArchiveSettings } from "./settings.js";
import { getSessionsRoot } from "./paths.js";
import { sweepSessions } from "./sweep.js";
import { showArchivePicker } from "./picker.js";

export default function sessionArchiveExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "startup" && event.reason !== "reload") return;
    const settings = getSessionArchiveSettings();
    if (!settings.enabled) return;

    const root = getSessionsRoot();
    const sessionDir = ctx.sessionManager.getSessionDir();
    const activeFile = ctx.sessionManager.getSessionFile();

    void sweepSessions({
      sessionDir,
      root,
      maxAgeDays: settings.maxAgeDays,
      activeFile,
      now: Date.now(),
    }).then(
      (count) => {
        if (count > 0 && ctx.hasUI) {
          ctx.ui.notify(`Archived ${count} session${count === 1 ? "" : "s"}`, "info");
        }
      },
      () => {
        // Background housekeeping: never surface unexpected errors.
      },
    );
  });

  pi.registerCommand("archive", {
    description: "Browse archived sessions and restore one into the current folder",
    getArgumentCompletions: () => [],
    handler: async (_args, ctx) => {
      await showArchivePicker(ctx);
    },
  });
}
