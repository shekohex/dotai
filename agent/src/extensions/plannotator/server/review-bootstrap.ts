import {
  contentHash,
  loadConfig,
  getDisplayRepo,
  getMRLabel,
  getMRNumberLabel,
  prRefFromMetadata,
  getPRDiffScopeOptions,
  getPRStackInfo,
  resolveStackInfo,
  type DiffType,
  type GitContext,
  type PRDiffScope,
  type PRListItem,
  type PRMetadata,
  type PRStackTree,
} from "./review-generated-deps.js";
import { fetchPRStack, fetchPRViewedFiles, getPRUser, getRepoInfo } from "./review-local-deps.js";
import type { ReviewMutableState } from "./review-diff-routes.js";

export async function createReviewBootstrap(args: {
  rawPatch: string;
  gitRef: string;
  diffType?: DiffType;
  gitContext?: GitContext;
  initialBase?: string;
  error?: string;
  prMetadata?: PRMetadata;
  worktreeEnabled: boolean;
  detectedCompareTarget: () => string;
}) {
  let draftKey = contentHash(args.rawPatch);
  let prMeta = args.prMetadata;
  const isPRMode = prMeta !== undefined;
  let prRef = prMeta ? prRefFromMetadata(prMeta) : null;
  let platformUser = null;
  if (prRef !== null) {
    platformUser = await getPRUser(prRef);
  }
  let prStackInfo = isPRMode ? getPRStackInfo(prMeta) : null;
  let prDiffScopeOptions = isPRMode ? getPRDiffScopeOptions(prMeta, args.worktreeEnabled) : [];
  let prListCache: PRListItem[] | null = null;
  let prListCacheTime = 0;
  const prSwitchCache = new Map<string, { metadata: PRMetadata; rawPatch: string }>();
  if (isPRMode) {
    prSwitchCache.set(prMeta.url, { metadata: prMeta, rawPatch: args.rawPatch });
  }
  const prStackTreeCache = new Map<string, PRStackTree | null>();
  let prStackTree: PRStackTree | null = null;
  if (prRef !== null && prMeta !== undefined) {
    try {
      prStackTree = await fetchPRStack(prRef, prMeta);
    } catch {}
    prStackTreeCache.set(prMeta.url, prStackTree);
    const resolved = resolveStackInfo(prMeta, prStackTree, prStackInfo);
    if (resolved && prStackInfo === null) {
      prStackInfo = resolved;
      prDiffScopeOptions = getPRDiffScopeOptions(prMeta, args.worktreeEnabled);
    }
  }
  let initialViewedFiles: string[] = [];
  if (isPRMode && prRef !== null) {
    try {
      const viewedMap = await fetchPRViewedFiles(prRef);
      initialViewedFiles = Object.entries(viewedMap)
        .filter(([, isViewed]) => isViewed)
        .map(([path]) => path);
    } catch {}
  }
  let repoInfo = prMeta
    ? {
        display: getDisplayRepo(prMeta),
        branch: `${getMRLabel(prMeta)} ${getMRNumberLabel(prMeta)}`,
      }
    : getRepoInfo();
  let currentPatch = args.rawPatch;
  let currentGitRef = args.gitRef;
  let currentDiffType: DiffType = args.diffType ?? "uncommitted";
  let currentError = args.error;
  let currentHideWhitespace = loadConfig().diffOptions?.hideWhitespace ?? false;
  let originalPRPatch = args.rawPatch;
  let originalPRGitRef = args.gitRef;
  let originalPRError = args.error;
  let currentPRDiffScope: PRDiffScope = "layer";
  let currentBase = args.initialBase ?? args.detectedCompareTarget();
  let baseEverSwitched = false;
  const reviewState: ReviewMutableState = {
    currentPatch,
    currentGitRef,
    currentDiffType,
    currentError,
    currentHideWhitespace,
    currentBase,
    baseEverSwitched,
    originalPRPatch,
    originalPRGitRef,
    originalPRError,
    currentPRDiffScope,
    draftKey,
    prMeta,
    prRef,
    prStackInfo,
    prStackTree,
    prDiffScopeOptions,
    prListCache,
    prListCacheTime,
    initialViewedFiles,
    repoInfo,
  };
  return {
    draftKey,
    prMeta,
    isPRMode,
    prRef,
    platformUser,
    prStackInfo,
    prDiffScopeOptions,
    prListCache,
    prListCacheTime,
    prSwitchCache,
    prStackTreeCache,
    prStackTree,
    initialViewedFiles,
    repoInfo,
    currentPatch,
    currentGitRef,
    currentDiffType,
    currentError,
    currentHideWhitespace,
    originalPRPatch,
    originalPRGitRef,
    originalPRError,
    currentPRDiffScope,
    currentBase,
    baseEverSwitched,
    reviewState,
  };
}
