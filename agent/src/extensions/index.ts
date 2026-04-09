import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import commentaryModeExtension from "./commentary-mode.js";
import coreUIExtension from "./coreui.js";
import litellmGatewayExtension from "./litellm.js";
import openUsageExtension from "./openusage/index.js";
import patchExtension from "./patch.js";
import webFetchExtension from "./fetch.js";
import webSearchExtension from "./websearch.js";
import compactionExtension from "./compaction.js";
import handoffExtension from "./handoff.js";
import debugProviderRequestExtension from "./debug-provider-request.js";
import bundledResourcesExtension from "./bundled-resources.js";
import mermaidExtension from "./mermaid.js";
import sessionQueryExtension from "./session-query.js";
import modesExtension from "./modes.js";

export const bundledExtensionFactories: ExtensionFactory[] = [
  bundledResourcesExtension,
  coreUIExtension,
  litellmGatewayExtension,
  openUsageExtension,
  patchExtension,
  webFetchExtension,
  webSearchExtension,
  commentaryModeExtension,
  modesExtension,
  compactionExtension,
  handoffExtension,
  debugProviderRequestExtension,
  mermaidExtension,
  sessionQueryExtension,
];
