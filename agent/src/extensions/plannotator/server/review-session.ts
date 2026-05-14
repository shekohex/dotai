import type { ReviewMutableState } from "./review-diff-routes.js";
import { createReviewStateBridge } from "./review-runtime.js";
import { createReviewAgentJobs } from "./review-agent-jobs.js";
import { resolveVcsCwd } from "./review-local-deps.js";
import type {
  DiffType,
  GitContext,
  PRDiffScope,
  PRMetadata,
  WorktreePool,
} from "./review-generated-deps.js";
import type { EditorAnnotationInput } from "./annotations.js";
import { createReviewAIEndpoints } from "./review-ai-endpoints.js";

function canLaunchReviewAgent(args: {
  getPrMeta: () => PRMetadata | undefined;
  worktreePool?: WorktreePool;
  agentCwd?: string;
}): boolean {
  const prMeta = args.getPrMeta();
  if (prMeta === undefined) {
    return true;
  }
  if (args.worktreePool !== undefined) {
    const poolPath = args.worktreePool.resolve(prMeta.url);
    if (poolPath !== undefined && poolPath.length > 0) {
      return true;
    }
  }
  return args.agentCwd !== undefined && args.agentCwd.length > 0;
}

export function createReviewSession(args: {
  reviewState: ReviewMutableState;
  getLocals: () => ReviewMutableState;
  setLocals: (state: ReviewMutableState) => void;
  gitContext?: GitContext;
  agentCwd?: string;
  worktreePool?: WorktreePool;
  getPrMeta: () => PRMetadata | undefined;
  getCurrentDiffType: () => DiffType;
  getCurrentPatch: () => string;
  getCurrentBase: () => string;
  getCurrentPrDiffScope: () => PRDiffScope;
  getServerUrl: () => string;
  addAnnotations: (annotations: EditorAnnotationInput[]) => void;
  getCachedPrMetadata: (url: string) => PRMetadata | undefined;
}) {
  const { syncStateFromLocals, syncLocalsFromState } = createReviewStateBridge({
    reviewState: args.reviewState,
    getLocals: args.getLocals,
    setLocals: args.setLocals,
  });

  function resolveAgentCwd(): string {
    const prMeta = args.getPrMeta();
    if (args.worktreePool !== undefined && prMeta !== undefined) {
      const poolPath = args.worktreePool.resolve(prMeta.url);
      if (poolPath !== undefined && poolPath.length > 0) return poolPath;
    }
    if (args.agentCwd !== undefined && args.agentCwd.length > 0) return args.agentCwd;
    return resolveVcsCwd(args.getCurrentDiffType(), args.gitContext?.cwd) ?? process.cwd();
  }

  const { tour, agentJobs } = createReviewAgentJobs({
    canLaunchReviewAgent: () => canLaunchReviewAgent(args),
    resolveAgentCwd,
    getCurrentPatch: args.getCurrentPatch,
    getCurrentDiffType: args.getCurrentDiffType,
    getCurrentBase: args.getCurrentBase,
    getCurrentPrDiffScope: args.getCurrentPrDiffScope,
    getPrMeta: args.getPrMeta,
    addAnnotations: args.addAnnotations,
  });

  const ai = createReviewAIEndpoints({ resolveAgentCwd });

  let resolveDecision!: (result: {
    approved: boolean;
    feedback: string;
    annotations: unknown[];
    agentSwitch?: string;
    exit?: boolean;
  }) => void;
  const decisionPromise = new Promise<{
    approved: boolean;
    feedback: string;
    annotations: unknown[];
    agentSwitch?: string;
    exit?: boolean;
  }>((resolve) => {
    resolveDecision = resolve;
  });

  return {
    syncStateFromLocals,
    syncLocalsFromState,
    resolveAgentCwd,
    tour,
    agentJobs,
    aiEndpoints: ai.endpoints,
    decisionPromise,
    resolveDecision,
    dispose: () => {
      agentJobs.dispose();
      ai.dispose();
    },
  };
}

export type ReviewSession = ReturnType<typeof createReviewSession>;
