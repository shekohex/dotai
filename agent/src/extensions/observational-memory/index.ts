import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerOmCommand } from "./commands/om.js";
import { registerCompactionHook } from "./hooks/compaction-hook.js";
import { registerCompactionTrigger } from "./hooks/compaction-trigger.js";
import { registerCompactionReminder } from "./hooks/reminder.js";
import { registerConsolidationTrigger } from "./hooks/consolidation-trigger.js";
import { Runtime } from "./runtime.js";
import { registerRecallTool } from "./tools/recall-observation.js";

export default function observationalMemory(pi: ExtensionAPI) {
  const runtime = new Runtime();

  registerConsolidationTrigger(pi, runtime);
  registerCompactionTrigger(pi, runtime);
  registerCompactionHook(pi, runtime);
  registerCompactionReminder(pi, runtime);

  registerOmCommand(pi, runtime);
  registerRecallTool(pi);
}
