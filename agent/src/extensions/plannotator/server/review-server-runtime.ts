import { createReviewSession } from "./review-session.js";
import type { ReviewSession } from "./review-session.js";
import { startReviewLifecycle } from "./review-lifecycle.js";
import type { ReviewMutableState } from "./review-diff-routes.js";
import type {
  DiffType,
  GitContext,
  PRDiffScope,
  PRMetadata,
  WorktreePool,
} from "./review-generated-deps.js";
import type { EditorAnnotationInput } from "./annotations.js";
import type { ReviewServerResult } from "./serverReview.js";
import type { IncomingMessage, ServerResponse } from "node:http";

export function startReviewRuntime(args: {
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
  getCachedPrMetadata: (url: string) => PRMetadata | undefined;
  addAnnotations: (annotations: EditorAnnotationInput[]) => void;
  isRemote: boolean;
  onReady?: (url: string, isRemote: boolean, port: number) => void;
  onCleanup?: () => void | Promise<void>;
  createDispatchContext: (args: {
    req: IncomingMessage;
    res: ServerResponse;
    url: URL;
    session: ReviewSession;
    aiEndpoints: Record<string, (req: Request) => Promise<Response>> | null;
  }) => Parameters<typeof startReviewLifecycle>[0]["createDispatchContext"] extends (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ) => infer T
    ? T
    : never;
}): Promise<ReviewServerResult> {
  let serverUrl = args.getServerUrl();
  const session = createReviewSession({
    reviewState: args.reviewState,
    getLocals: args.getLocals,
    setLocals: args.setLocals,
    gitContext: args.gitContext,
    agentCwd: args.agentCwd,
    worktreePool: args.worktreePool,
    getPrMeta: args.getPrMeta,
    getCurrentDiffType: args.getCurrentDiffType,
    getCurrentPatch: args.getCurrentPatch,
    getCurrentBase: args.getCurrentBase,
    getCurrentPrDiffScope: args.getCurrentPrDiffScope,
    getServerUrl: () => serverUrl,
    addAnnotations: args.addAnnotations,
    getCachedPrMetadata: args.getCachedPrMetadata,
  });
  return startReviewLifecycle({
    createDispatchContext: (req, res, url) =>
      args.createDispatchContext({
        req,
        res,
        url,
        session,
        aiEndpoints: null,
      }),
    getServerUrl: () => serverUrl,
    setServerUrl: (url) => {
      serverUrl = url;
    },
    isRemote: args.isRemote,
    onReady: args.onReady,
    killAll: () => {
      void session.agentJobs.killAll();
    },
    disposeAi: () => {
      session.dispose();
    },
    onCleanup: args.onCleanup,
    decisionPromise: session.decisionPromise,
  });
}
