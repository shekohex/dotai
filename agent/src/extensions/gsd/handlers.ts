import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { GsdCommandArgs } from "./args.js";
import { handleGsdHealth } from "./instant/health.js";
import { handleGsdNext } from "./instant/next.js";
import { handleGsdStats } from "./instant/stats.js";
import { handleGsdStatus } from "./instant/status.js";
import {
  handleGsdCompleteMilestone,
  handleGsdDebug,
  handleGsdDiscussPhase,
  handleGsdExecutePhase,
  handleGsdMapCodebase,
  handleGsdMilestoneSummary,
  handleGsdNewMilestone,
  handleGsdNewProject,
  handleGsdPlanPhase,
  handleGsdProgress,
  handleGsdSecurePhase,
  handleGsdValidatePhase,
  handleGsdVerifyWork,
} from "./lifecycle/index.js";

export type GsdHandler = (
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: GsdCommandArgs,
  rawArgs: string,
) => Promise<void> | void;

export const gsdHandlers = {
  "new-project": handleGsdNewProject,
  "new-milestone": handleGsdNewMilestone,
  "complete-milestone": handleGsdCompleteMilestone,
  "milestone-summary": handleGsdMilestoneSummary,
  debug: handleGsdDebug,
  "map-codebase": handleGsdMapCodebase,
  "discuss-phase": handleGsdDiscussPhase,
  "plan-phase": handleGsdPlanPhase,
  "execute-phase": handleGsdExecutePhase,
  "secure-phase": handleGsdSecurePhase,
  "verify-work": handleGsdVerifyWork,
  "validate-phase": handleGsdValidatePhase,
  next: handleGsdNext,
  progress: handleGsdProgress,
  stats: handleGsdStats,
  health: handleGsdHealth,
  status: handleGsdStatus,
} satisfies Record<string, GsdHandler>;
