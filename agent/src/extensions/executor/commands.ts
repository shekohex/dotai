import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, type AutocompleteItem } from "@earendil-works/pi-tui";
import { errorMessage } from "../../utils/error-message.js";
import { openBrowserTarget } from "./browser.js";
import { ExecutorUnavailableError } from "./connection.js";
import { connectExecutor } from "./status.js";
import { showExecutorStatusView, showExecutorWebView } from "./ui.js";

type ExecutorSubcommand = "on" | "off" | "status" | "web";

export interface ExecutorCommandHost {
  isEnabled(): boolean;
  enable(ctx: ExtensionCommandContext): Promise<void>;
  disable(ctx: ExtensionCommandContext): void;
}

const EXECUTOR_SUBCOMMANDS: Array<{ value: ExecutorSubcommand; description: string }> = [
  { value: "on", description: "Enable Executor execute tool for agent turns" },
  { value: "off", description: "Disable Executor execute tool for agent turns" },
  { value: "status", description: "Show active Executor status and built-in endpoints" },
  { value: "web", description: "Open the active Executor web UI" },
];

function filterAutocompleteItems(
  items: AutocompleteItem[],
  query: string,
): AutocompleteItem[] | null {
  if (items.length === 0) {
    return null;
  }

  if (!query) {
    return items;
  }

  const filtered = fuzzyFilter(
    items,
    query,
    (item) => `${item.label} ${item.value} ${item.description ?? ""}`,
  );
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

async function handleExecutorStatus(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  try {
    await connectExecutor(pi, ctx);
  } catch (error) {
    if (error instanceof ExecutorUnavailableError) {
      await showExecutorStatusView(ctx, error.attempts);
      return;
    }

    await showExecutorStatusView(ctx);
    return;
  }

  await showExecutorStatusView(ctx);
}

const handleExecutorWeb = async (pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> => {
  const endpoint = await connectExecutor(pi, ctx);

  try {
    await openBrowserTarget(endpoint.webUrl);
    await showExecutorWebView(ctx, endpoint);
  } catch (error) {
    const message = errorMessage(error);
    await showExecutorWebView(ctx, endpoint, message);
  }
};

function parseSubcommand(args: string): ExecutorSubcommand {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const token = tokens[0];
  if (!token) {
    return "status";
  }

  if (tokens.length > 1) {
    throw new Error("Usage: /executor [on|off|status|web]");
  }

  if (token === "on" || token === "off" || token === "status" || token === "web") {
    return token;
  }

  throw new Error("Usage: /executor [on|off|status|web]");
}

export const registerExecutorCommands = (pi: ExtensionAPI, host: ExecutorCommandHost): void => {
  pi.registerCommand("executor", {
    description: "Manage built-in Executor integration: /executor [on|off|status|web]",
    getArgumentCompletions: (prefix) => getExecutorArgumentCompletions(prefix),
    handler: async (args, ctx) => {
      const subcommand = parseSubcommand(args);

      if (subcommand === "on") {
        await host.enable(ctx);
        ctx.ui.notify("Executor tool enabled.");
        return;
      }

      if (subcommand === "off") {
        host.disable(ctx);
        ctx.ui.notify("Executor tool disabled.");
        return;
      }

      if (subcommand === "status") {
        await handleExecutorStatus(pi, ctx);
        return;
      }

      await handleExecutorWeb(pi, ctx);
    },
  });
};
