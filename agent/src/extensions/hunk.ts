import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  HerdrClient,
  currentHerdrTabId,
  currentHerdrWorkspaceId,
  isRunningInHerdr,
} from "../herdr/client.js";
import { errorMessage } from "../utils/error-message.js";

const HUNK_COMMAND = "hunk diff --watch --theme catppuccin-mocha --agent-notes --no-hunk-headers";
const HUNK_ARGUMENT_COMPLETIONS = [
  {
    value: "staged",
    label: "staged",
    description: "Review staged changes",
  },
] as const;

function resolveHunkCommand(args: string): string | undefined {
  const argument = args.trim();
  if (argument.length === 0) return HUNK_COMMAND;
  return argument === "staged" ? `${HUNK_COMMAND} --staged` : undefined;
}

function commandFailureDetail(result: { code: number; stderr: string; stdout: string }): string {
  return result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
}

async function resolveHunkTabLabel(pi: ExtensionAPI, cwd: string): Promise<string> {
  try {
    const result = await pi.exec("git", ["branch", "--show-current"], { cwd });
    const branch = result.code === 0 ? result.stdout.trim() : "";
    return branch.length === 0 ? "Hunk" : `Hunk: ${branch}`;
  } catch {
    return "Hunk";
  }
}

export default function hunkExtension(pi: ExtensionAPI): void {
  pi.registerCommand("hunk", {
    description: "Open current changes in a watched Hunk review tab",
    getArgumentCompletions(prefix) {
      const normalizedPrefix = prefix.trim().toLowerCase();
      const completions = HUNK_ARGUMENT_COMPLETIONS.filter((completion) =>
        completion.value.startsWith(normalizedPrefix),
      );
      return completions.length === 0 ? null : completions;
    },
    async handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
      const hunkCommand = resolveHunkCommand(args);
      if (hunkCommand === undefined) {
        ctx.ui.notify("Usage: /hunk [staged]", "warning");
        return;
      }
      if (!isRunningInHerdr()) {
        ctx.ui.notify("Hunk requires an active Herdr pane", "warning");
        return;
      }

      try {
        const originalTabId = currentHerdrTabId();
        const hunkVersion = await pi.exec("hunk", ["--version"], { cwd: ctx.cwd });
        if (hunkVersion.code !== 0) {
          ctx.ui.notify(
            `Hunk unavailable: ${commandFailureDetail(hunkVersion)}. Install with npm i -g hunkdiff`,
            "error",
          );
          return;
        }

        const client = new HerdrClient((command, options) => pi.exec("herdr", command, options));
        const { paneId } = await client.createTab({
          cwd: ctx.cwd,
          label: await resolveHunkTabLabel(pi, ctx.cwd),
          workspaceId: currentHerdrWorkspaceId(),
          focus: true,
        });
        await client.runPaneUntilExit(paneId, hunkCommand, {
          cwd: ctx.cwd,
          restoreTabId: originalTabId,
        });
      } catch (error) {
        ctx.ui.notify(`Hunk launch failed: ${errorMessage(error)}`, "error");
      }
    },
  });
}
