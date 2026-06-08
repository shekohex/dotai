import bundledResourcesExtension from "./bundled-resources.js";
import commitExtension from "./commit.js";
import coreUIExtension from "./coreui.js";
import glanceExtension from "./glance/index.js";
import gitStateExtension from "./git-state.js";
import litellmGatewayExtension from "./litellm.js";
import modesExtension from "./modes.js";
import openAIBetterExtension from "./openai-better/index.js";
import openUsageExtension from "./openusage/index.js";
import patchExtension from "./patch.js";
import projectTrustExtension from "./project-trust.js";
import webSearchExtension from "./websearch.js";
import type { GroupedExtensionDefinition } from "./definitions.js";

export const groupedExtensionsA: GroupedExtensionDefinition[] = [
  { id: "project-trust", factory: projectTrustExtension },
  { id: "bundled-resources", factory: bundledResourcesExtension },
  { id: "git-state", factory: gitStateExtension },
  { id: "coreui", factory: coreUIExtension },
  { id: "glance", factory: glanceExtension },
  { id: "litellm", factory: litellmGatewayExtension },
  { id: "openai-better", factory: openAIBetterExtension },
  { id: "openusage", factory: openUsageExtension },
  { id: "patch", factory: patchExtension },
  { id: "websearch", factory: webSearchExtension },
  { id: "modes", factory: modesExtension },
  { id: "commit", factory: commitExtension },
];
