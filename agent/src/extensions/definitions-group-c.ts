import agentAlertsExtension from "./agent-alerts/index.js";
import askUserQuestionExtension from "./ask-user-question/index.js";
import cacheGraphExtension from "./cache-graph/index.js";
import contextPruneExtension from "./context-prune/index.js";
import executorExtension from "./executor/index.js";
import goalExtension from "./goal/index.js";
import gsdExtension from "./gsd/index.js";
import mermaidExtension from "./mermaid.js";
import notifyExtension from "./notify/index.js";
import piOscExtension from "./pi-osc/extension.js";
import plannotatorExtension from "./plannotator.js";
import promptStashExtension from "./prompt-stash.js";
import terminalTmuxUiExtension from "./terminal-tmux-ui.js";
import tmuxShareExtension from "./tmux-share/index.js";
import warpExtension from "./warp/index.js";
import type { GroupedExtensionDefinition } from "./definitions.js";

export const groupedExtensionsC: GroupedExtensionDefinition[] = [
  { id: "agent-alerts", factory: agentAlertsExtension },
  { id: "cache-graph", factory: cacheGraphExtension },
  { id: "context-prune", factory: contextPruneExtension },
  { id: "mermaid", factory: mermaidExtension },
  { id: "notify", factory: notifyExtension },
  { id: "goal", factory: goalExtension },
  { id: "prompt-stash", factory: promptStashExtension },
  { id: "ask-user-question", factory: askUserQuestionExtension },
  { id: "plannotator", factory: plannotatorExtension },
  { id: "gsd", factory: gsdExtension },
  { id: "terminal-tmux-ui", factory: terminalTmuxUiExtension },
  { id: "pi-osc", factory: piOscExtension },
  { id: "warp", factory: warpExtension },
  { id: "executor", factory: executorExtension },
  { id: "tmux-share", factory: tmuxShareExtension },
];
