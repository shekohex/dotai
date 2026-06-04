import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ResolvedSubagentMode } from "./modes.js";
import type { SubagentRuntimeHooks } from "./runtime-hooks.js";
import type { RuntimeSubagent } from "./types.js";

export { isTerminalSubagentStatus } from "./status.js";

export function resolveLiteRuntimeModel(
  ctx: ExtensionContext,
  mode: ResolvedSubagentMode,
  requestedModel: string | undefined,
): Model<Api> | undefined {
  const modelSpec = requestedModel ?? mode.model;
  if (modelSpec === undefined) {
    return ctx.model;
  }

  const slashIndex = modelSpec.indexOf("/");
  if (slashIndex <= 0 || slashIndex === modelSpec.length - 1) {
    return ctx.model;
  }

  const provider = modelSpec.slice(0, slashIndex);
  const modelId = modelSpec.slice(slashIndex + 1);
  return ctx.modelRegistry.find(provider, modelId);
}

export function renderLiteRuntimeWidget(
  hooks: SubagentRuntimeHooks,
  ctx: ExtensionContext | undefined,
  states: RuntimeSubagent[],
): ExtensionContext | undefined {
  if (ctx === undefined) {
    return undefined;
  }
  hooks.renderWidget(ctx, states);
  return ctx;
}
