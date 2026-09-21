import { copyToClipboard, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "../../../utils/error-message.js";
import type { Runtime } from "../runtime.js";
import {
  fullProjection,
  observationToSummaryLine,
  reflectionToSummaryLine,
  visibleProjection,
  type Entry,
  type Projection,
} from "../session-ledger/index.js";

function firstArg(args: unknown): string | undefined {
  if (typeof args === "string") return args.trim().split(/\s+/)[0];
  if (Array.isArray(args)) return typeof args[0] === "string" ? args[0] : undefined;
  if (args !== null && typeof args === "object" && "mode" in args) {
    const mode: unknown = args.mode;
    return typeof mode === "string" ? mode : undefined;
  }
  return undefined;
}

function renderList<T>(items: T[], render: (item: T) => string, empty: string): string {
  return items.length > 0 ? items.map((item) => render(item)).join("\n") : empty;
}

function renderContentOnlyProjection(
  projection: Projection,
  emptyScope: "visible" | "recorded",
): string {
  return [
    "── Reflections ──",
    renderList(projection.reflections, reflectionToSummaryLine, `No ${emptyScope} reflections.`),
    "",
    "── Observations ──",
    renderList(projection.observations, observationToSummaryLine, `No ${emptyScope} observations.`),
  ].join("\n");
}

export async function runViewCommand(
  runtime: Runtime,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  runtime.ensureConfig(ctx.cwd);
  const entries = ctx.sessionManager.getBranch() as Entry[];
  const mode = firstArg(args);

  const notifyWithCopy = async (output: string) => {
    try {
      await copyToClipboard(output);
      ctx.ui.notify(`${output}\n\nCopied /om view output to clipboard.`, "info");
    } catch (cause) {
      ctx.ui.notify(
        `${output}\n\nWarning: failed to copy /om view output to clipboard: ${errorMessage(cause)}`,
        "info",
      );
    }
  };

  if (mode === "full") {
    await notifyWithCopy(renderContentOnlyProjection(fullProjection(entries), "recorded"));
    return;
  }

  if (mode !== undefined && mode !== "visible") {
    ctx.ui.notify("Usage: /om view [full]", "info");
    return;
  }

  await notifyWithCopy(renderContentOnlyProjection(visibleProjection(entries), "visible"));
}
