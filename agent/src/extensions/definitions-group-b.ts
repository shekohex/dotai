import agentsMdExtension from "./agents-md.js";
import compactionExtension from "./compaction.js";
import contextExtension from "./context.js";
import debugProviderRequestExtension from "./debug-provider-request.js";
import filesExtension from "./files.js";
import handoffExtension from "./handoff.js";
import reviewExtension from "./review.js";
import sessionBreakdownExtension from "./session-breakdown.js";
import sessionQueryExtension from "./session-query.js";
import type { GroupedExtensionDefinition } from "./definitions.js";

export const groupedExtensionsB: GroupedExtensionDefinition[] = [
  { id: "review", factory: reviewExtension },
  { id: "agents-md", factory: agentsMdExtension },
  { id: "compaction", factory: compactionExtension },
  { id: "handoff", factory: handoffExtension },
  { id: "debug-provider-request", factory: debugProviderRequestExtension },
  { id: "session-query", factory: sessionQueryExtension },
  { id: "context", factory: contextExtension },
  { id: "session-breakdown", factory: sessionBreakdownExtension },
  { id: "files", factory: filesExtension },
];
