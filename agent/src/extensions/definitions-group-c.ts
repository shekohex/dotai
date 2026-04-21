import executorExtension from "./executor/index.js";
import mermaidExtension from "./mermaid.js";
import promptStashExtension from "./prompt-stash.js";
import terminalNotifyExtension from "./terminal-notify.js";
import type { GroupedExtensionDefinition } from "./definitions.js";

export const groupedExtensionsC: GroupedExtensionDefinition[] = [
  { id: "mermaid", factory: mermaidExtension },
  { id: "prompt-stash", factory: promptStashExtension },
  { id: "terminal-notify", factory: terminalNotifyExtension },
  { id: "executor", factory: executorExtension },
];
