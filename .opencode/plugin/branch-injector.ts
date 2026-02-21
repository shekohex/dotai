import type { Plugin } from "@opencode-ai/plugin";
import crypto from "crypto";

export const BranchInjector: Plugin = async ({ $, client }) => {
  const sessionBranches = new Map<string, string>();
  const sessionGitRoots = new Map<string, string | null>();

  const resolveSessionGitRoot = async (sessionID: string): Promise<string | null> => {
    if (sessionGitRoots.has(sessionID)) {
      return sessionGitRoots.get(sessionID) ?? null;
    }

    const sessionResult = await client.session.get({
      path: { id: sessionID },
      throwOnError: true,
    });

    const result = await $`git -C ${sessionResult.data.directory} rev-parse --show-toplevel`
      .quiet()
      .nothrow();

    if (result.exitCode !== 0) {
      sessionGitRoots.set(sessionID, null);
      return null;
    }

    const gitRoot = result.stdout.toString().trim();
    if (!gitRoot) {
      sessionGitRoots.set(sessionID, null);
      return null;
    }

    sessionGitRoots.set(sessionID, gitRoot);
    return gitRoot;
  };

  return {

    "chat.message": async (input, output) => {
      let gitRoot: string | null;
      try {
        gitRoot = await resolveSessionGitRoot(input.sessionID);
      } catch {
        return;
      }

      if (!gitRoot) return;

      const result = await $`git -C ${gitRoot} branch --show-current`.quiet().nothrow();
      if (result.exitCode !== 0) return;

      const branch = result.stdout.toString().trim();

      if (!branch) return;

      const lastBranch = sessionBranches.get(input.sessionID);

      if (lastBranch === branch) return;

      sessionBranches.set(input.sessionID, branch);

      const info = lastBranch
        ? `[Branch changed: ${lastBranch} → ${branch}]`
        : `[Current branch: ${branch}]`;

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

    event: async ({ event }) => {
      if (event.type === "session.deleted") {
        const sessionID = event.properties.info.id;
        sessionBranches.delete(sessionID);
        sessionGitRoots.delete(sessionID);
      }
    },
  };
};
