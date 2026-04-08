import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import commentaryModeExtension from "./commentary-mode.js";
import coreUIExtension from "./coreui.js";
import litellmGatewayExtension from "./litellm.js";
import openUsageExtension from "./openusage/index.js";
import patchExtension from "./patch.js";
import webFetchExtension from "./fetch.js";
import webSearchExtension from "./websearch.js";
import compaction from "./compaction.js";
import handoff from "./handoff.js";
import debugProviderRequestExtension from "./debug-provider-request.js";
import bundledResourcesExtension from "./bundled-resources.js";
import mermaidExtension from "./mermaid.js";

export const bundledExtensionFactories: ExtensionFactory[] = [
  bundledResourcesExtension,
  coreUIExtension,
  litellmGatewayExtension,
  openUsageExtension,
  patchExtension,
  webFetchExtension,
  webSearchExtension,
  commentaryModeExtension,
  compaction,
  handoff,
  debugProviderRequestExtension,
  mermaidExtension,
];
