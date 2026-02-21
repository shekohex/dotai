import type { Plugin } from "@opencode-ai/plugin";
import crypto from "crypto";

export const BranchInjector: Plugin = async ({ $ }) => {
  // Track last known branch per session
  const sessionBranches = new Map<string, string>();

  return {

    "chat.message": async (input, output) => {
      const result = await $`git branch --show-current`.quiet();
      const branch = result.stdout.toString().trim();

      if (!branch) return; // Not in git repo or detached HEAD

      const lastBranch = sessionBranches.get(input.sessionID);

      // Only inject if unknown or changed
      if (lastBranch === branch) return;

      // Update tracking
      sessionBranches.set(input.sessionID, branch);

      // Determine message based on whether branch changed or first time
      const info = lastBranch
        ? `[Branch changed: ${lastBranch} → ${branch}]`
        : `[Current branch: ${branch}]`;

      // Add as synthetic part (hidden from TUI, sent to model)
      const first = output.parts[0];
      if (!first) return;
      output.parts.push({
        id: crypto.randomUUID(),
        sessionID: first.sessionID,
        messageID: first.messageID,
        type: "text",
        text: info,
        synthetic: true,
      });
    },

    // Clean up on session delete
    event: async ({ event }) => {
      if (event.type === "session.deleted") {
        sessionBranches.delete(event.properties.info.id);
      }
    },
  };
};
