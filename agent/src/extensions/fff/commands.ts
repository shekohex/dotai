import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { FileFinder } from "@ff-labs/fff-node";

type FinderGetter = () => FileFinder | null;

const FFF_COMMAND_ITEMS = [
  { value: "health", label: "health", description: "Show FFF status" },
  { value: "rescan", label: "rescan", description: "Trigger FFF to rescan files" },
] as const;

function showFffHealth(finder: FileFinder, ctx: ExtensionCommandContext): void {
  const health = finder.healthCheck();
  if (!health.ok) {
    ctx.ui.notify(`Health check failed: ${health.error}`, "error");
    return;
  }

  const h = health.value;
  const lines = [
    `FFF v${h.version}`,
    `Git: ${h.git.repositoryFound ? `yes (${h.git.workdir ?? "unknown"})` : "no"}`,
    `Picker: ${h.filePicker.initialized ? `${h.filePicker.indexedFiles ?? 0} files` : "not initialized"}`,
    `Frecency: ${h.frecency.initialized ? "active" : "disabled"}`,
    `Query tracker: ${h.queryTracker.initialized ? "active" : "disabled"}`,
  ];

  const progress = finder.getScanProgress();
  if (progress.ok) {
    lines.push(
      `Scanning: ${progress.value.isScanning ? "yes" : "no"} (${progress.value.scannedFilesCount} files)`,
    );
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

function rescanFff(finder: FileFinder, ctx: ExtensionCommandContext): void {
  const result = finder.scanFiles();
  if (!result.ok) {
    ctx.ui.notify(`Rescan failed: ${result.error}`, "error");
    return;
  }

  ctx.ui.notify("FFF rescan triggered", "info");
}

export function registerFffCommand(pi: ExtensionAPI, getFinder: FinderGetter): void {
  pi.registerCommand("fff", {
    description: "FFF tools: /fff health | /fff rescan",
    getArgumentCompletions(prefix) {
      const normalizedPrefix = prefix.trimStart();
      return FFF_COMMAND_ITEMS.filter((item) => item.value.startsWith(normalizedPrefix));
    },
    handler(args, ctx) {
      const subcommand = args.trim();
      const finder = getFinder();
      if (finder === null || finder.isDestroyed) {
        ctx.ui.notify("FFF not initialized", "warning");
        return Promise.resolve();
      }

      if (subcommand === "health" || subcommand.length === 0) {
        showFffHealth(finder, ctx);
        return Promise.resolve();
      }
      if (subcommand === "rescan") {
        rescanFff(finder, ctx);
        return Promise.resolve();
      }

      ctx.ui.notify("Usage: /fff health | /fff rescan", "warning");
      return Promise.resolve();
    },
  });
}
