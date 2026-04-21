import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createSessionBreakdownHandler } from "./ui.js";

export default function sessionBreakdownExtension(pi: ExtensionAPI) {
  pi.registerCommand("session-breakdown", {
    description:
      "Interactive breakdown of last 7/30/90 days of ~/.pi session usage (sessions/messages/tokens + cost by model)",
    handler: createSessionBreakdownHandler(pi),
  });
}
