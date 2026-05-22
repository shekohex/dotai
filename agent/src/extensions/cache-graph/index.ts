import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { exportStatsCsv } from "./export.js";
import { type GraphView, GRAPH_VIEWS, graphViewLabel, renderGraphBody } from "./graph-view.js";
import { ScrollDialog } from "./scroll-dialog.js";
import { collectCacheSessionMetrics } from "./session-data.js";
import { renderStatsBody } from "./stats-view.js";

function normalizeSubcommand(args: string): string {
  return args.trim().toLowerCase();
}

function usageText(): string {
  return "Usage: /cache graph | /cache stats | /cache export";
}

export default function cacheGraphExtension(pi: ExtensionAPI): void {
  pi.registerCommand("cache", {
    description: "Show cache hit graph, token/cache statistics, or export CSV",
    getArgumentCompletions(prefix) {
      const items = [
        { value: "graph", label: "graph", description: "Show cache hit % graph over time" },
        { value: "stats", label: "stats", description: "Show token/cache breakdown table" },
        {
          value: "export",
          label: "export",
          description: "Export stats data to a CSV at project root",
        },
      ];

      const filtered = items.filter((item) => item.value.startsWith(prefix.toLowerCase()));
      return filtered.length > 0 ? filtered : items;
    },
    handler: async (args, ctx) => {
      const subcommand = normalizeSubcommand(args);

      if (subcommand !== "graph" && subcommand !== "stats" && subcommand !== "export") {
        ctx.ui.notify(usageText(), "info");
        return;
      }

      let metrics = collectCacheSessionMetrics(ctx.sessionManager);

      if (subcommand === "export") {
        const filePath = await exportStatsCsv(ctx.cwd, ctx.sessionManager, metrics);
        ctx.ui.notify(`Exported cache stats CSV to ${filePath}`, "info");
        return;
      }

      if (!ctx.hasUI) {
        ctx.ui.notify(
          "/cache graph and /cache stats require interactive TUI mode. Use /cache export in non-interactive mode.",
          "info",
        );
        return;
      }

      if (subcommand === "graph") {
        let currentView: GraphView = "per-turn";

        await ctx.ui.custom<void>(
          (_tui, theme, _keybindings, done) =>
            new ScrollDialog(
              theme,
              {
                title: "Context Cache Graph",
                getTitle: () => `Context Cache Graph — ${graphViewLabel(currentView)}`,
                helpText: "1/2/3 view • r refresh • v cycle • ↑/↓ scroll • PgUp/PgDn • q/Esc close",
                renderBody: (innerWidth) =>
                  renderGraphBody(theme, metrics, innerWidth, currentView),
                onKey: (data) => {
                  if (data === "r") {
                    metrics = collectCacheSessionMetrics(ctx.sessionManager);
                    return true;
                  }
                  if (data === "1") currentView = "per-turn";
                  else if (data === "2") currentView = "cumulative-percent";
                  else if (data === "3") currentView = "cumulative-total";
                  else if (data === "v") {
                    const idx = GRAPH_VIEWS.indexOf(currentView);
                    currentView = GRAPH_VIEWS[(idx + 1) % GRAPH_VIEWS.length]!;
                  } else if (data === "V") {
                    const idx = GRAPH_VIEWS.indexOf(currentView);
                    currentView = GRAPH_VIEWS[(idx + GRAPH_VIEWS.length - 1) % GRAPH_VIEWS.length]!;
                  } else {
                    return false;
                  }
                  return true;
                },
              },
              () => {
                done();
              },
            ),
          {
            overlay: true,
            overlayOptions: {
              anchor: "center",
              width: "90%",
              maxHeight: "90%",
              margin: 1,
            },
          },
        );
        return;
      }

      // stats
      await ctx.ui.custom<void>(
        (_tui, theme, _keybindings, done) =>
          new ScrollDialog(
            theme,
            {
              title: "Context Cache Stats",
              helpText: "r refresh • ↑/↓ scroll • PgUp/PgDn • q/Esc close",
              renderBody: (innerWidth) => renderStatsBody(theme, metrics, innerWidth),
              onKey: (data) => {
                if (data === "r") {
                  metrics = collectCacheSessionMetrics(ctx.sessionManager);
                  return true;
                }
                return false;
              },
            },
            () => {
              done();
            },
          ),
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: "90%",
            maxHeight: "90%",
            margin: 1,
          },
        },
      );
    },
  });
}
