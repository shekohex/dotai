import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { GsdCommandArgs } from "./args.js";
import { handleGsdHealth } from "./instant/health.js";
import { handleGsdNext } from "./instant/next.js";
import { handleGsdProgress } from "./instant/progress.js";
import { handleGsdStats } from "./instant/stats.js";
import { handleGsdDiscussPhase } from "./lifecycle/discuss-phase.js";
import { handleGsdExecutePhase } from "./lifecycle/execute-phase.js";
import { handleGsdMapCodebase } from "./lifecycle/map-codebase.js";
import { handleGsdNewProject } from "./lifecycle/new-project.js";
import { handleGsdPlanPhase } from "./lifecycle/plan-phase.js";
import { handleGsdValidatePhase } from "./lifecycle/validate-phase.js";
import { handleGsdVerifyWork } from "./lifecycle/verify-work.js";

export type GsdHandler = (
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: GsdCommandArgs,
) => Promise<void> | void;

export const gsdHandlers = {
  "new-project": handleGsdNewProject,
  "map-codebase": handleGsdMapCodebase,
  "discuss-phase": handleGsdDiscussPhase,
  "plan-phase": handleGsdPlanPhase,
  "execute-phase": handleGsdExecutePhase,
  "verify-work": handleGsdVerifyWork,
  "validate-phase": handleGsdValidatePhase,
  next: handleGsdNext,
  progress: handleGsdProgress,
  stats: handleGsdStats,
  health: handleGsdHealth,
} satisfies Record<string, GsdHandler>;
