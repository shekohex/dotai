import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { fuzzyFilter, type AutocompleteItem } from "@mariozechner/pi-tui";
import { openBrowserTarget } from "./browser.js";
import { ExecutorUnavailableError } from "./connection.js";
import type { JsonObject } from "./http.js";
import { formatExecutorSettings, getExecutorSettings } from "./settings.js";
import {
  connectExecutor,
  formatExecutorRuntimeState,
  getExecutorState,
} from "./status.js";

type ExecutorSubcommand = "status" | "web";

const EXECUTOR_SUBCOMMANDS: Array<{ value: ExecutorSubcommand; description: string }> = [
  { value: "status", description: "Show active Executor status and built-in endpoints" },
  { value: "web", description: "Open the active Executor web UI" },
];

function filterAutocompleteItems(items: AutocompleteItem[], query: string): AutocompleteItem[] | null {
  if (items.length === 0) {
    return null;
  }

  if (!query) {
    return items;
  }

  const filtered = fuzzyFilter(items, query, (item) => `${item.label} ${item.value} ${item.description ?? ""}`);
  return filtered.length > 0 ? filtered : null;
}

function getExecutorArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  const normalizedPrefix = argumentPrefix.replace(/^\s+/, "");
  const items = EXECUTOR_SUBCOMMANDS.map((item) => ({
    value: item.value,
    label: item.value,
    description: item.description,
  }));

  if (!normalizedPrefix) {
    return items;
  }

  const tokens = normalizedPrefix.split(/\s+/).filter(Boolean);
  if (tokens.length > 1) {
    return null;
  }

  return filterAutocompleteItems(items, tokens[0] ?? "");
}

const notifyResult = (
  pi: ExtensionAPI,
  customType: string,
  text: string,
  details: JsonObject,
): void => {
  pi.sendMessage({
    customType,
    content: text,
    display: true,
    details,
  });
};

function buildExecutorStatusDetails(ctx: ExtensionCommandContext): JsonObject {
  const state = getExecutorState(ctx.cwd);
  const settings = getExecutorSettings();

  return {
    cwd: ctx.cwd,
    state,
    autoStart: settings.autoStart,
    probeTimeoutMs: settings.probeTimeoutMs,
    candidates: settings.candidates.map((candidate) => ({
      label: candidate.label,
      mcpUrl: candidate.mcpUrl,
    })),
  };
}

function buildStatusLines(ctx: ExtensionCommandContext): string[] {
  return [
    ...formatExecutorRuntimeState(getExecutorState(ctx.cwd)),
    "",
    ...formatExecutorSettings(getExecutorSettings()),
    `cwd: ${ctx.cwd}`,
  ];
}

async function handleExecutorStatus(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  try {
    await connectExecutor(pi, ctx);
  } catch (error) {
    const lines = [...buildStatusLines(ctx)];
    if (error instanceof ExecutorUnavailableError) {
      lines.push("");
      lines.push(...error.attempts.map((attempt) => `${attempt.label}: ${attempt.error}`));
    }

    notifyResult(pi, "executor", lines.join("\n"), buildExecutorStatusDetails(ctx));
    return;
  }

  notifyResult(pi, "executor", buildStatusLines(ctx).join("\n"), buildExecutorStatusDetails(ctx));
}

const handleExecutorWeb = async (pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> => {
  const endpoint = await connectExecutor(pi, ctx);

  try {
    await openBrowserTarget(endpoint.webUrl);
    notifyResult(pi, "executor", `Executor UI: ${endpoint.webUrl}`, {
      candidate: endpoint.label,
      mcpUrl: endpoint.mcpUrl,
      webUrl: endpoint.webUrl,
      scopeId: endpoint.scope.id,
      scopeDir: endpoint.scope.dir,
      launched: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notifyResult(
      pi,
      "executor",
      `Executor UI: ${endpoint.webUrl}\n\nBrowser launch failed: ${message}`,
      {
        candidate: endpoint.label,
        mcpUrl: endpoint.mcpUrl,
        webUrl: endpoint.webUrl,
        scopeId: endpoint.scope.id,
        scopeDir: endpoint.scope.dir,
        launched: false,
      },
    );
  }
};

function parseSubcommand(args: string): ExecutorSubcommand {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const token = tokens[0];
  if (!token) {
    return "status";
  }

  if (tokens.length > 1) {
    throw new Error("Usage: /executor [status|web]");
  }

  if (token === "status" || token === "web") {
    return token;
  }

  throw new Error("Usage: /executor [status|web]");
}

export const registerExecutorCommands = (pi: ExtensionAPI): void => {
  pi.registerCommand("executor", {
    description: "Manage built-in Executor integration: /executor [status|web]",
    getArgumentCompletions: (prefix) => getExecutorArgumentCompletions(prefix),
    handler: async (args, ctx) => {
      const subcommand = parseSubcommand(args);

      if (subcommand === "status") {
        await handleExecutorStatus(pi, ctx);
        return;
      }

      await handleExecutorWeb(pi, ctx);
    },
  });
};
