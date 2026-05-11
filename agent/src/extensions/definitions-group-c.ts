import executorExtension from "./executor/index.js";
import gsdExtension from "./gsd/index.js";
import interviewExtension from "./interview/index.js";
import mermaidExtension from "./mermaid.js";
import plannotatorExtension from "./plannotator.js";
import promptStashExtension from "./prompt-stash.js";
import terminalNotifyExtension from "./terminal-notify.js";
import terminalTmuxUiExtension from "./terminal-tmux-ui.js";
import type { GroupedExtensionDefinition } from "./definitions.js";

export const groupedExtensionsC: GroupedExtensionDefinition[] = [
  { id: "mermaid", factory: mermaidExtension },
  { id: "prompt-stash", factory: promptStashExtension },
  { id: "interview", factory: interviewExtension },
  { id: "plannotator", factory: plannotatorExtension },
  { id: "gsd", factory: gsdExtension },
  { id: "terminal-notify", factory: terminalNotifyExtension },
  { id: "terminal-tmux-ui", factory: terminalTmuxUiExtension },
  { id: "executor", factory: executorExtension },
];
