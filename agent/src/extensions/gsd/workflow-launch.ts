import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { MODE_ACTIVATE_EVENT } from "../modes/index.js";
import {
  resolveSessionLaunchOptions,
  type ResolvedSessionLaunchOptions,
} from "../session-launch-utils.js";
import { getGsdBundleDir, resolveGsdBundlePath } from "./resources.js";

type GsdWorkflowLaunchConfig = {
  promptOverride?: string;
  commandName: string;
  commandArguments?: string;
  mode?: string;
  sessionStrategy?: "current" | "fork" | "new";
  commandResourcePath: string;
  workflowResourcePaths?: string[];
  extraResourcePaths?: string[];
  extraRequiredReadingPaths?: string[];
  extraInstructions?: string[];
};

type PendingGsdWorkflowLaunch = {
  prompt: string;
  overrides?: ResolvedSessionLaunchOptions;
};

declare global {
  var __shekohexPendingGsdWorkflowLaunch: PendingGsdWorkflowLaunch | undefined;
}

function getPendingGsdWorkflowLaunch(): PendingGsdWorkflowLaunch | undefined {
  return globalThis.__shekohexPendingGsdWorkflowLaunch;
}

function setPendingGsdWorkflowLaunch(pending: PendingGsdWorkflowLaunch | undefined): void {
  globalThis.__shekohexPendingGsdWorkflowLaunch = pending;
}

function buildWorkflowLaunchPrompt(config: GsdWorkflowLaunchConfig, cwd: string): string {
  if (config.promptOverride !== undefined) {
    return config.promptOverride;
  }

  const commandArguments =
    config.commandArguments !== undefined && config.commandArguments.length > 0
      ? config.commandArguments
      : undefined;
  const resources = [
    resolveGsdBundlePath(config.commandResourcePath),
    ...(config.workflowResourcePaths ?? []).map((path) => resolveGsdBundlePath(path)),
    ...(config.extraResourcePaths ?? []).map((path) => resolveGsdBundlePath(path)),
    ...(config.extraRequiredReadingPaths ?? []),
  ];
  const gsdBundleDir = getGsdBundleDir();
  const gsdToolsPath = resolveGsdBundlePath("bin", "gsd-tools.cjs");
  return [
    `Launch native GSD workflow for "/gsd ${config.commandName}${commandArguments === undefined ? "" : ` ${commandArguments}`}".`,
    "",
    "- Read bundled workflow files below before acting.",
    "- Treat workflow docs as local adapted behavior contract, not literal shell script.",
    "- Local runtime adaptation notes are embedded in bundled command/workflow files.",
    "- Keep `.planning` outputs compatible with local readers.",
    "- Stay inside local repo runtime.",
    "- Use user confirmations where workflow expects gates.",
    "",
    `Working directory: ${cwd}`,
    `Command arguments: ${commandArguments ?? "(none)"}`,
    `Runtime contract: GSD_BUNDLE_DIR=${gsdBundleDir}`,
    `Runtime contract: GSD_TOOLS_PATH=${gsdToolsPath}`,
    "",
    "Required reading:",
    ...resources.map((path) => `- ${path}`),
    ...(config.extraInstructions === undefined || config.extraInstructions.length === 0
      ? []
      : ["", "Extra instructions:", ...config.extraInstructions.map((line) => `- ${line}`)]),
    "",
    "After reading, state short plan, then execute workflow end-to-end.",
  ].join("\n");
}

async function resolveLaunchOverrides(
  ctx: ExtensionContext,
  mode: string | undefined,
): Promise<ResolvedSessionLaunchOptions | undefined> {
  if (mode === undefined) {
    return undefined;
  }
  const resolved = await resolveSessionLaunchOptions(ctx, { mode });
  return resolved.overrides;
}

export async function applyPendingGsdWorkflowLaunch(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  reason: "startup" | "reload" | "new" | "resume" | "fork",
): Promise<void> {
  if (reason !== "new" && reason !== "fork") {
    return;
  }

  const pending = getPendingGsdWorkflowLaunch();
  if (!pending) {
    return;
  }

  setPendingGsdWorkflowLaunch(undefined);

  const pendingMode = pending.overrides?.mode;
  if (
    pendingMode !== undefined &&
    pendingMode.length > 0 &&
    typeof pi.events?.emit === "function"
  ) {
    await new Promise<void>((resolve, reject) => {
      pi.events.emit(MODE_ACTIVATE_EVENT, {
        ctx,
        mode: pendingMode,
        reason: "restore",
        source: "session_start",
        done: { resolve, reject },
      });
    });
  }
}

export async function launchGsdWorkflowSession(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  config: GsdWorkflowLaunchConfig,
): Promise<void> {
  const prompt = buildWorkflowLaunchPrompt(config, ctx.cwd);
  const overrides = await resolveLaunchOverrides(ctx, config.mode);

  if ((config.sessionStrategy ?? "fork") === "current") {
    const pendingMode = overrides?.mode;
    if (
      pendingMode !== undefined &&
      pendingMode.length > 0 &&
      typeof pi.events?.emit === "function"
    ) {
      await new Promise<void>((resolve, reject) => {
        pi.events.emit(MODE_ACTIVATE_EVENT, {
          ctx,
          mode: pendingMode,
          reason: "restore",
          source: "session_start",
          done: { resolve, reject },
        });
      });
    }
    pi.sendUserMessage(prompt, { deliverAs: "steer" });
    return;
  }

  setPendingGsdWorkflowLaunch({ prompt, overrides });

  try {
    const shouldFork = (config.sessionStrategy ?? "fork") === "fork";
    const leafId = ctx.sessionManager.getLeafId();
    if (shouldFork && leafId !== undefined && leafId !== null) {
      try {
        const forkResult = await ctx.fork(leafId, {
          position: "at",
          withSession: async (replacementCtx) => {
            await replacementCtx.sendUserMessage(prompt, { deliverAs: "steer" });
          },
        });
        if (!forkResult.cancelled) {
          return;
        }
      } catch {
        // Fall back to a new session when the active leaf entry is stale or missing.
      }
    }

    const parentSession = ctx.sessionManager.getSessionFile() ?? undefined;
    const newSessionResult = await ctx.newSession({
      parentSession,
      withSession: async (replacementCtx) => {
        await replacementCtx.sendUserMessage(prompt, { deliverAs: "steer" });
      },
    });
    if (newSessionResult.cancelled) {
      setPendingGsdWorkflowLaunch(undefined);
    }
  } catch (error) {
    setPendingGsdWorkflowLaunch(undefined);
    throw error;
  }
}
