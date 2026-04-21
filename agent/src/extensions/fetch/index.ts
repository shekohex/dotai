import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { formatToolRail } from "../coreui/tools.js";
import {
  createWebFetchRequest,
  executeWebFetchRequest,
  resolveFirecrawlApiKey,
} from "./execution.js";
import {
  createTextComponent,
  formatDurationHuman,
  getElapsedMs,
  getTextContent,
  renderFetchCompleteResult,
  renderFetchErrorResult,
  renderFetchPartialResult,
  syncRenderState,
} from "./render.js";
import {
  clampTimeout,
  FIRECRAWL_API_KEY_ENV,
  isWebFetchRenderState,
  parseWebFetchDetails,
  shortenUrl,
  upgradeToHttps,
  WEBFETCH_DESCRIPTION,
  webFetchSchema,
} from "./types.js";

export { FIRECRAWL_API_KEY_ENV, resolveFirecrawlApiKey };

export const webFetchTool = defineTool({
  name: "webfetch",
  label: "fetch",
  renderShell: "self",
  description: WEBFETCH_DESCRIPTION,
  promptSnippet:
    "use `webfetch` tool when you need to get the conent of a url or a website. could be useful to explore more information from the references output of the `websearch` tool.",
  parameters: webFetchSchema,
  renderCall(args, theme, context) {
    const state = syncRenderState(context, context.isPartial, isWebFetchRenderState);
    const rail = formatToolRail(theme, context);
    const url = shortenUrl(typeof args.url === "string" ? upgradeToHttps(args.url.trim()) : "...");
    const timeoutSeconds = clampTimeout(
      typeof args.timeout === "number" ? args.timeout : undefined,
    );
    const elapsedMs = getElapsedMs(state);

    if (context.isError) {
      const suffix =
        elapsedMs === undefined
          ? ""
          : theme.fg("muted", ` after ${formatDurationHuman(elapsedMs)}`);
      return createTextComponent(
        context.lastComponent,
        `${rail}${theme.bold(theme.fg("error", "fetch"))} ${theme.fg("muted", url)}${suffix}`,
      );
    }

    if (context.isPartial) {
      return createTextComponent(
        context.lastComponent,
        `${rail}${theme.bold(theme.fg("dim", "fetching"))} ${theme.fg("muted", url)}${theme.fg("muted", ` (${timeoutSeconds}s)`)}`,
      );
    }

    const suffix =
      elapsedMs === undefined ? "" : theme.fg("muted", ` in ${formatDurationHuman(elapsedMs)}`);
    return createTextComponent(
      context.lastComponent,
      `${rail}${theme.bold(theme.fg("dim", "fetched"))} ${theme.fg("muted", url)}${suffix}`,
    );
  },
  renderResult(result, options, theme, context) {
    const details = parseWebFetchDetails(result.details);
    const rail = formatToolRail(theme, context);
    const textContent = getTextContent(result.content);
    if (context.isError) {
      return renderFetchErrorResult(
        options.expanded,
        context.lastComponent,
        rail,
        textContent,
        theme,
      );
    }
    if (options.isPartial) {
      return renderFetchPartialResult(
        options.expanded,
        context.lastComponent,
        rail,
        textContent,
        details,
        theme,
      );
    }
    return renderFetchCompleteResult(options.expanded, context.lastComponent, rail, details, theme);
  },
  execute(_toolCallId, params, signal, onUpdate) {
    const request = createWebFetchRequest(params, signal, onUpdate);
    return executeWebFetchRequest(request, onUpdate);
  },
});

export default function webFetchExtension(pi: ExtensionAPI) {
  pi.registerTool(webFetchTool);
}
