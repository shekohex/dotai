import agentAlertsExtension from "./agent-alerts/index.js";
import executorExtension from "./executor/index.js";
import goalExtension from "./goal/index.js";
import gsdExtension from "./gsd/index.js";
import interviewExtension from "./interview/index.js";
import mermaidExtension from "./mermaid.js";
import notifyExtension from "./notify/index.js";
import plannotatorExtension from "./plannotator.js";
import promptStashExtension from "./prompt-stash.js";
import terminalNotifyExtension from "./terminal-notify.js";
import terminalTmuxUiExtension from "./terminal-tmux-ui.js";
import type { GroupedExtensionDefinition } from "./definitions.js";

export const groupedExtensionsC: GroupedExtensionDefinition[] = [
  { id: "agent-alerts", factory: agentAlertsExtension },
  { id: "mermaid", factory: mermaidExtension },
  { id: "notify", factory: notifyExtension },
  { id: "goal", factory: goalExtension },
  { id: "prompt-stash", factory: promptStashExtension },
  { id: "interview", factory: interviewExtension },
  { id: "plannotator", factory: plannotatorExtension },
  { id: "gsd", factory: gsdExtension },
  { id: "terminal-notify", factory: terminalNotifyExtension },
  { id: "terminal-tmux-ui", factory: terminalTmuxUiExtension },
  { id: "executor", factory: executorExtension },
];
