import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

const { default: modelFamilySystemPromptExtension } =
  await import("./model-family-system-prompt.js");
const { default: bundledResourcesExtension } = await import("./bundled-resources.js");
const { default: coreUIExtension } = await import("./coreui.js");
const { default: litellmGatewayExtension } = await import("./litellm.js");
const { default: openUsageExtension } = await import("./openusage/index.js");
const { default: patchExtension } = await import("./patch.js");
const { default: webSearchExtension } = await import("./websearch.js");
const { default: modesExtension } = await import("./modes.js");
const { default: commitExtension } = await import("./commit.js");
const { default: reviewExtension } = await import("./review.js");
const { default: agentsMdExtension } = await import("./agents-md.js");
const { default: compactionExtension } = await import("./compaction.js");
const { default: handoffExtension } = await import("./handoff.js");
const { default: debugProviderRequestExtension } = await import("./debug-provider-request.js");
const { default: sessionQueryExtension } = await import("./session-query.js");
const { default: contextExtension } = await import("./context.js");
const { default: sessionBreakdownExtension } = await import("./session-breakdown.js");
const { default: filesExtension } = await import("./files.js");
const { default: mermaidExtension } = await import("./mermaid.js");
const { default: promptStashExtension } = await import("./prompt-stash.js");
const { default: terminalNotifyExtension } = await import("./terminal-notify.js");
const { default: executorExtension } = await import("./executor/index.js");

type BundledExtensionHost = "server-bound" | "ui-only";

export interface GroupedExtensionDefinition {
  id: string;
  host: BundledExtensionHost;
  factory: ExtensionFactory;
}

export const groupedExtensionsA: GroupedExtensionDefinition[] = [
  {
    id: "model-family-system-prompt",
    host: "server-bound",
    factory: modelFamilySystemPromptExtension,
  },
  { id: "bundled-resources", host: "server-bound", factory: bundledResourcesExtension },
  { id: "coreui", host: "server-bound", factory: coreUIExtension },
  { id: "litellm", host: "server-bound", factory: litellmGatewayExtension },
  { id: "openusage", host: "server-bound", factory: openUsageExtension },
  { id: "patch", host: "server-bound", factory: patchExtension },
  { id: "websearch", host: "server-bound", factory: webSearchExtension },
  { id: "modes", host: "server-bound", factory: modesExtension },
  { id: "commit", host: "server-bound", factory: commitExtension },
];

export const groupedExtensionsB: GroupedExtensionDefinition[] = [
  { id: "review", host: "server-bound", factory: reviewExtension },
  { id: "agents-md", host: "server-bound", factory: agentsMdExtension },
  { id: "compaction", host: "server-bound", factory: compactionExtension },
  { id: "handoff", host: "server-bound", factory: handoffExtension },
  { id: "debug-provider-request", host: "server-bound", factory: debugProviderRequestExtension },
  { id: "session-query", host: "server-bound", factory: sessionQueryExtension },
  { id: "context", host: "server-bound", factory: contextExtension },
  { id: "session-breakdown", host: "server-bound", factory: sessionBreakdownExtension },
  { id: "files", host: "server-bound", factory: filesExtension },
];

export const groupedExtensionsC: GroupedExtensionDefinition[] = [
  { id: "mermaid", host: "ui-only", factory: mermaidExtension },
  { id: "prompt-stash", host: "ui-only", factory: promptStashExtension },
  { id: "terminal-notify", host: "ui-only", factory: terminalNotifyExtension },
  { id: "executor", host: "server-bound", factory: executorExtension },
];
