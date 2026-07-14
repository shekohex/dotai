import agentsMdExtension from "./agents-md.js";
import autoTreesExtension from "./auto-trees/index.js";
import branchSummaryExtension from "./branch-summary.js";
import compactionExtension from "./compaction.js";
import contextExtension from "./context.js";
import debugProviderRequestExtension from "./debug-provider-request.js";
import dynamicWorkflowsExtension from "./dynamic-workflows/extension.js";
import filesExtension from "./files.js";
import handoffExtension from "./handoff.js";
import referencesExtension from "./references/index.js";
import recapExtension from "./recap/index.js";
import reviewExtension from "./review.js";
import sessionArchiveExtension from "./session-archive/index.js";
import sessionBreakdownExtension from "./session-breakdown.js";
import sessionNameExtension from "./session-name.js";
import sessionQueryExtension from "./session-query.js";
import skillReadExtension from "./skill-read.js";
import type { GroupedExtensionDefinition } from "./definitions.js";

export const groupedExtensionsB: GroupedExtensionDefinition[] = [
  { id: "review", factory: reviewExtension },
  { id: "auto-trees", factory: autoTreesExtension },
  { id: "agents-md", factory: agentsMdExtension },
  { id: "branch-summary", factory: branchSummaryExtension },
  { id: "compaction", factory: compactionExtension },
  { id: "handoff", factory: handoffExtension },
  { id: "debug-provider-request", factory: debugProviderRequestExtension },
  { id: "dynamic-workflows", factory: dynamicWorkflowsExtension },
  { id: "session-query", factory: sessionQueryExtension },
  { id: "session-archive", factory: sessionArchiveExtension },
  { id: "context", factory: contextExtension },
  { id: "session-breakdown", factory: sessionBreakdownExtension },
  { id: "session-name", factory: sessionNameExtension },
  { id: "recap", factory: recapExtension },
  { id: "references", factory: referencesExtension },
  { id: "files", factory: filesExtension },
  { id: "skill-read", factory: skillReadExtension },
];
