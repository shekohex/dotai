import bundledResourcesExtension from "./bundled-resources.js";
import commitExtension from "./commit.js";
import coreUIExtension from "./coreui.js";
import litellmGatewayExtension from "./litellm.js";
import modesExtension from "./modes.js";
import modelFamilySystemPromptExtension from "./model-family-system-prompt.js";
import openUsageExtension from "./openusage/index.js";
import patchExtension from "./patch.js";
import webSearchExtension from "./websearch.js";
import type { GroupedExtensionDefinition } from "./definitions.js";

export const groupedExtensionsA: GroupedExtensionDefinition[] = [
  {
    id: "model-family-system-prompt",
    factory: modelFamilySystemPromptExtension,
  },
  { id: "bundled-resources", factory: bundledResourcesExtension },
  { id: "coreui", factory: coreUIExtension },
  { id: "litellm", factory: litellmGatewayExtension },
  { id: "openusage", factory: openUsageExtension },
  { id: "patch", factory: patchExtension },
  { id: "websearch", factory: webSearchExtension },
  { id: "modes", factory: modesExtension },
  { id: "commit", factory: commitExtension },
];
