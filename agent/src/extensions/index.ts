import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import modelFamilySystemPromptExtension from "./model-family-system-prompt.js";
import coreUIExtension from "./coreui.js";
import litellmGatewayExtension from "./litellm.js";
import openUsageExtension from "./openusage/index.js";
import patchExtension from "./patch.js";
import webSearchExtension from "./websearch.js";
import compactionExtension from "./compaction.js";
import handoffExtension from "./handoff.js";
import debugProviderRequestExtension from "./debug-provider-request.js";
import bundledResourcesExtension from "./bundled-resources.js";
import mermaidExtension from "./mermaid.js";
import sessionQueryExtension from "./session-query.js";
import modesExtension from "./modes.js";
import contextExtension from "./context.js";
import sessionBreakdownExtension from "./session-breakdown.js";
import filesExtension from "./files.js";
import promptStashExtension from "./prompt-stash.js";
import terminalNotifyExtension from "./terminal-notify.js";
import subagentExtension from "./subagent.js";
import executorExtension from "./executor/index.js";

export const bundledExtensionFactories: ExtensionFactory[] = [
  modelFamilySystemPromptExtension,
  bundledResourcesExtension,
  coreUIExtension,
  litellmGatewayExtension,
  openUsageExtension,
  patchExtension,
  // Disabled: no need to use webfetch, it can just curl markdown
  // webFetchExtension,
  webSearchExtension,
  modesExtension,
  compactionExtension,
  handoffExtension,
  debugProviderRequestExtension,
  mermaidExtension,
  sessionQueryExtension,
  contextExtension,
  sessionBreakdownExtension,
  filesExtension,
  promptStashExtension,
  terminalNotifyExtension,
  executorExtension,
  subagentExtension,
];
