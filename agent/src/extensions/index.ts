import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import bundledResourcesExtension from "./bundled-resources.js";
import commentaryModeExtension from "./commentary-mode.js";
import coreUIExtension from "./coreui.js";
import litellmGatewayExtension from "./litellm.js";
import openUsageExtension from "./openusage/index.js";
import webSearchExtension from "./websearch.js";
import compaction from "./compaction.js";
import handoff from "./handoff.js";

export const bundledExtensionFactories: ExtensionFactory[] = [
  litellmGatewayExtension,
  webSearchExtension,
  openUsageExtension,
  coreUIExtension,
  bundledResourcesExtension,
  commentaryModeExtension,
  compaction,
  handoff,
];
