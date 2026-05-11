import { existsSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createWorktreePool, type WorktreePool } from "./generated/worktree-pool.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "../../utils/error-message.js";
import {
  openBrowserTarget,
  resolveBrowserAccessUrl,
  shouldAutoOpenBrowser,
} from "../../utils/browser-launch.js";
import {
  prepareLocalReviewDiff,
  reviewRuntime,
  startAnnotateServer,
  startPlanReviewServer,
  startReviewServer,
  type DiffType,
  type VcsSelection,
} from "./server.js";
import { isRemoteSession } from "./server/network.js";
import { parsePRUrl, checkPRAuth, fetchPR } from "./server/pr.js";
import {
  getMRLabel,
  getMRNumberLabel,
  getDisplayRepo,
  getCliName,
  getCliInstallUrl,
} from "./generated/pr-provider.js";
import { parseRemoteUrl } from "./generated/repo.js";
import { fetchRef, createWorktree, ensureObjectAvailable } from "./generated/worktree.js";
import { loadConfig, resolveDefaultDiffType } from "./generated/config.js";
export { getLastAssistantMessageText } from "./assistant-message.js";

export type AnnotateMode = "annotate" | "annotate-folder" | "annotate-last";
export interface PlanReviewDecision {
  approved: boolean;
  feedback?: string;
  savedPath?: string;
  agentSwitch?: string;
  permissionMode?: string;
}

export interface BrowserDecisionSession<T> {
  url: string;
  waitForDecision: () => Promise<T>;
  stop: () => void;
}

export interface PlanReviewBrowserSession extends BrowserDecisionSession<PlanReviewDecision> {
  reviewId: string;
  onDecision: (listener: (result: PlanReviewDecision) => void | Promise<void>) => () => void;
}

type CodeReviewSessionResult = {
  rawPatch: string;
  gitRef: string;
  diffError?: string;
  gitContext?: Awaited<ReturnType<typeof prepareLocalReviewDiff>>["gitContext"];
  prMetadata?: Awaited<ReturnType<typeof fetchPR>>["metadata"];
  diffType?: DiffType;
  agentCwd?: string;
  initialBase?: string;
  worktreeCleanup?: () => void | Promise<void>;
  worktreePool?: WorktreePool;
};

type LocalPrCheckoutResult = {
  agentCwd?: string;
  worktreeCleanup?: () => void | Promise<void>;
  worktreePool?: WorktreePool;
};

async function detectSameRepoCheckout(
  repoDir: string,
  prMetadata: NonNullable<CodeReviewSessionResult["prMetadata"]>,
): Promise<boolean> {
  try {
    const remoteResult = await reviewRuntime.runGit(["remote", "get-url", "origin"], {
      cwd: repoDir,
    });
    if (remoteResult.exitCode !== 0) {
      return false;
    }
    const remoteUrl = remoteResult.stdout.trim();
    const currentRepo = parseRemoteUrl(remoteUrl);
    const prRepo =
      prMetadata.platform === "github"
        ? `${prMetadata.owner}/${prMetadata.repo}`
        : prMetadata.projectPath;
    const repoMatches = currentRepo !== null && currentRepo.toLowerCase() === prRepo.toLowerCase();
    const sshHost = remoteUrl.match(/^[^@]+@([^:]+):/)?.[1];
    const httpsHost = (() => {
      try {
        return new URL(remoteUrl).hostname;
      } catch {
        return null;
      }
    })();
    const remoteHost = (sshHost ?? httpsHost ?? "").toLowerCase();
    return repoMatches && remoteHost === prMetadata.host.toLowerCase();
  } catch {
    return false;
  }
}

async function prepareSameRepoWorktree(options: {
  repoDir: string;
  prMetadata: NonNullable<CodeReviewSessionResult["prMetadata"]>;
  fetchRefStr: string;
  localPath: string;
  sessionDir: string;
  getWorktreePool: () => WorktreePool | undefined;
}): Promise<{ worktreeCleanup: () => Promise<void>; exitHandler: () => void }> {
  console.error("Fetching PR branch and creating local worktree...");
  await fetchRef(reviewRuntime, options.prMetadata.baseBranch, { cwd: options.repoDir });
  await ensureObjectAvailable(reviewRuntime, options.prMetadata.baseSha, { cwd: options.repoDir });
  await fetchRef(reviewRuntime, options.fetchRefStr, { cwd: options.repoDir });
  await createWorktree(reviewRuntime, {
    ref: "FETCH_HEAD",
    path: options.localPath,
    detach: true,
    cwd: options.repoDir,
  });
  const exitHandler = () => {
    try {
      for (const entry of options.getWorktreePool()?.entries() ?? []) {
        spawnSync("git", ["worktree", "remove", "--force", entry.path], { cwd: options.repoDir });
      }
    } catch {}
    try {
      rmSync(options.sessionDir, { recursive: true, force: true });
    } catch {}
  };
  const worktreeCleanup = async () => {
    process.removeListener("exit", exitHandler);
    const worktreePool = options.getWorktreePool();
    if (worktreePool !== undefined) await worktreePool.cleanup(reviewRuntime);
    try {
      rmSync(options.sessionDir, { recursive: true, force: true });
    } catch {}
  };
  return { worktreeCleanup, exitHandler };
}

async function prepareCrossRepoWorktree(options: {
  prMetadata: NonNullable<CodeReviewSessionResult["prMetadata"]>;
  fetchRefStr: string;
  localPath: string;
  sessionDir: string;
}): Promise<{ worktreeCleanup: () => void; exitHandler: () => void }> {
  const prRepo =
    options.prMetadata.platform === "github"
      ? `${options.prMetadata.owner}/${options.prMetadata.repo}`
      : options.prMetadata.projectPath;
  if (prRepo.startsWith("-")) throw new Error(`Invalid repository identifier: ${prRepo}`);
  const cli = options.prMetadata.platform === "github" ? "gh" : "glab";
  const host = options.prMetadata.host;
  const isDefaultHost = host === "github.com" || host === "gitlab.com";
  const cloneEnv = isDefaultHost
    ? undefined
    : {
        ...process.env,
        ...(options.prMetadata.platform === "github" ? { GH_HOST: host } : { GITLAB_HOST: host }),
      };
  console.error(`Cloning ${prRepo} (shallow)...`);
  const cloneResult = spawnSync(
    cli,
    ["repo", "clone", prRepo, options.localPath, "--", "--depth=1", "--no-checkout"],
    { encoding: "utf-8", env: cloneEnv },
  );
  if ((cloneResult.status ?? 1) !== 0)
    throw new Error(`${cli} repo clone failed: ${(cloneResult.stderr ?? "").trim()}`);
  console.error("Fetching PR branch...");
  const fetchResult = await reviewRuntime.runGit(
    ["fetch", "--depth=200", "origin", options.fetchRefStr],
    { cwd: options.localPath },
  );
  if (fetchResult.exitCode !== 0)
    throw new Error(`Failed to fetch PR head ref: ${fetchResult.stderr.trim()}`);
  const checkoutResult = await reviewRuntime.runGit(["checkout", "FETCH_HEAD"], {
    cwd: options.localPath,
  });
  if (checkoutResult.exitCode !== 0)
    throw new Error(`git checkout FETCH_HEAD failed: ${checkoutResult.stderr.trim()}`);
  const baseFetch = await reviewRuntime.runGit(
    ["fetch", "--depth=200", "origin", options.prMetadata.baseSha],
    { cwd: options.localPath },
  );
  if (baseFetch.exitCode !== 0)
    console.error("Warning: failed to fetch baseSha, agent diffs may be inaccurate");
  await reviewRuntime.runGit(
    ["branch", "--", options.prMetadata.baseBranch, options.prMetadata.baseSha],
    { cwd: options.localPath },
  );
  await reviewRuntime.runGit(
    [
      "update-ref",
      `refs/remotes/origin/${options.prMetadata.baseBranch}`,
      options.prMetadata.baseSha,
    ],
    { cwd: options.localPath },
  );
  const exitHandler = () => {
    try {
      rmSync(options.sessionDir, { recursive: true, force: true });
    } catch {}
  };
  const worktreeCleanup = () => {
    process.removeListener("exit", exitHandler);
    try {
      rmSync(options.sessionDir, { recursive: true, force: true });
    } catch {}
  };
  return { worktreeCleanup, exitHandler };
}

const __dirname = import.meta.dirname;
let planHtmlContent = "";
let reviewHtmlContent = "";

function resolveBundledHtmlPath(fileName: string): string {
  return resolve(__dirname, "..", "..", "resources", "plannotator", fileName);
}

try {
  planHtmlContent = readFileSync(resolveBundledHtmlPath("plannotator.html"), "utf-8");
} catch {
  // built assets unavailable
}

try {
  reviewHtmlContent = readFileSync(resolveBundledHtmlPath("review-editor.html"), "utf-8");
} catch {
  // built assets unavailable
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

export function hasPlanBrowserHtml(): boolean {
  return Boolean(planHtmlContent);
}

export function hasReviewBrowserHtml(): boolean {
  return Boolean(reviewHtmlContent);
}

export function getStartupErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

function createStoppedError(): Error {
  return new Error("Plannotator browser session was stopped.");
}

function getBrowserAccessUrl(server: { url: string; port: number }): string {
  return resolveBrowserAccessUrl({ serverUrl: server.url, port: server.port });
}

function openBrowserForServer(server: { url: string; port: number }, ctx: ExtensionContext): void {
  const accessUrl = getBrowserAccessUrl(server);
  if (shouldAutoOpenBrowser()) {
    void openBrowserTarget(accessUrl).catch(() => {
      ctx.ui.notify(`Open this URL to review: ${accessUrl}`, "info");
    });
    return;
  }
  if (isRemoteSession()) {
    ctx.ui.notify(`[Plannotator] ${accessUrl}`, "info");
    return;
  }
  ctx.ui.notify(`Open this URL to review: ${accessUrl}`, "info");
}

function openBrowserAndWait<T>(
  server: { url: string; port: number; stop: () => void },
  ctx: ExtensionContext,
  waitForResult: () => Promise<T>,
): Promise<T> {
  openBrowserForServer(server, ctx);
  return waitForDecisionWithCleanup(server, waitForResult);
}

async function waitForDecisionWithCleanup<T>(
  server: { url: string; port: number; stop: () => void },
  waitForResult: () => Promise<T>,
): Promise<T> {
  try {
    const result = await waitForResult();
    await delay(1500);
    return result;
  } finally {
    server.stop();
  }
}

function startBrowserDecisionSession<T>(
  server: { url: string; port: number; stop: () => void },
  ctx: ExtensionContext,
  waitForResult: () => Promise<T>,
): BrowserDecisionSession<T> {
  openBrowserForServer(server, ctx);
  let stopped = false;
  let stopReject: ((err: Error) => void) | undefined;
  let decisionPromise: Promise<T> | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    server.stop();
    stopReject?.(createStoppedError());
    stopReject = undefined;
  };

  return {
    url: getBrowserAccessUrl(server),
    waitForDecision: () => {
      if (decisionPromise) return decisionPromise;
      if (stopped) return Promise.reject(createStoppedError());
      decisionPromise = (async () => {
        const stoppedPromise = new Promise<never>((_, reject) => {
          stopReject = reject;
        });
        try {
          const result = await Promise.race([waitForResult(), stoppedPromise]);
          stopReject = undefined;
          await delay(1500);
          return result;
        } finally {
          stop();
        }
      })();
      return decisionPromise;
    },
    stop,
  };
}

export async function startPlanReviewBrowserSession(
  ctx: ExtensionContext,
  planContent: string,
): Promise<PlanReviewBrowserSession> {
  if (!ctx.hasUI || !planHtmlContent) {
    throw new Error("Plannotator browser review is unavailable in this session.");
  }

  const server = await startPlanReviewServer({
    plan: planContent,
    htmlContent: planHtmlContent,
    origin: "pi",
    sharingEnabled: process.env.PLANNOTATOR_SHARE !== "disabled",
    shareBaseUrl: process.env.PLANNOTATOR_SHARE_URL ?? undefined,
    pasteApiUrl: process.env.PLANNOTATOR_PASTE_URL ?? undefined,
  });

  const session = startBrowserDecisionSession(server, ctx, server.waitForDecision);
  server.onDecision(() => {
    setTimeout(() => {
      session.stop();
    }, 1500);
  });

  return {
    ...session,
    reviewId: server.reviewId,
    onDecision: server.onDecision,
  };
}

export async function openPlanReviewBrowser(
  ctx: ExtensionContext,
  planContent: string,
): Promise<PlanReviewDecision> {
  const session = await startPlanReviewBrowserSession(ctx, planContent);
  return session.waitForDecision();
}

export function shouldUseLocalPrCheckout(options: { useLocal?: boolean }): boolean {
  return options.useLocal !== false;
}

async function createLocalReviewSession(
  ctx: ExtensionContext,
  options: {
    cwd?: string;
    defaultBranch?: string;
    diffType?: DiffType;
    vcsType?: VcsSelection;
  },
): Promise<CodeReviewSessionResult> {
  const cwd = options.cwd ?? ctx.cwd;
  const config = loadConfig();
  const result = await prepareLocalReviewDiff({
    cwd,
    vcsType: options.vcsType,
    requestedDiffType: options.diffType,
    requestedBase: options.defaultBranch,
    configuredDiffType: resolveDefaultDiffType(config),
    hideWhitespace: config.diffOptions?.hideWhitespace ?? false,
  });
  return {
    rawPatch: result.rawPatch,
    gitRef: result.gitRef,
    diffError: result.error,
    gitContext: result.gitContext,
    diffType: result.diffType,
    initialBase: result.base,
  };
}

async function createPrReviewSession(
  ctx: ExtensionContext,
  urlArg: string,
  _options: {
    cwd?: string;
    useLocal?: boolean;
  },
): Promise<CodeReviewSessionResult> {
  const prRef = parsePRUrl(urlArg);
  if (prRef === null) {
    throw new Error(
      `Invalid PR/MR URL: ${urlArg}\n` +
        "Supported formats:\n" +
        "  GitHub: https://github.com/owner/repo/pull/123\n" +
        "  GitLab: https://gitlab.com/group/project/-/merge_requests/42",
    );
  }

  const cliName = getCliName(prRef);
  const cliUrl = getCliInstallUrl(prRef);

  try {
    await checkPRAuth(prRef);
  } catch (err) {
    const message = errorMessage(err);
    if (message.includes("not found") || message.includes("ENOENT")) {
      throw new Error(
        `${cliName === "gh" ? "GitHub" : "GitLab"} CLI (${cliName}) is not installed. Install it from ${cliUrl}`,
        { cause: err },
      );
    }
    throw err;
  }

  console.error(
    `Fetching ${getMRLabel(prRef)} ${getMRNumberLabel(prRef)} from ${getDisplayRepo(prRef)}...`,
  );
  const pr = await fetchPR(prRef);
  return {
    rawPatch: pr.rawPatch,
    gitRef: `${getMRLabel(prRef)} ${getMRNumberLabel(prRef)}`,
    prMetadata: pr.metadata,
  };
}

async function createLocalPrCheckout(
  ctx: ExtensionContext,
  options: { cwd?: string },
  prMetadata: NonNullable<CodeReviewSessionResult["prMetadata"]>,
): Promise<LocalPrCheckoutResult> {
  let worktreeCleanup: (() => void | Promise<void>) | undefined;
  let worktreePool: WorktreePool | undefined;
  let exitHandler: (() => void) | undefined;
  let localPath: string | undefined;
  let sessionDir: string | undefined;

  try {
    const repoDir = options.cwd ?? ctx.cwd;
    const identifier =
      prMetadata.platform === "github"
        ? `${prMetadata.owner}-${prMetadata.repo}-${prMetadata.number}`
        : `${prMetadata.projectPath.replaceAll("/", "-")}-${prMetadata.iid}`;
    const suffix = Math.random().toString(36).slice(2, 8);
    const prNumber = prMetadata.platform === "github" ? prMetadata.number : prMetadata.iid;
    sessionDir = join(realpathSync(tmpdir()), `plannotator-pr-${identifier}-${suffix}`);
    localPath = join(sessionDir, "pool", `pr-${prNumber}`);
    const fetchRefStr =
      prMetadata.platform === "github"
        ? `refs/pull/${prMetadata.number}/head`
        : `refs/merge-requests/${prMetadata.iid}/head`;

    if (prMetadata.baseBranch.includes("..") || prMetadata.baseBranch.startsWith("-")) {
      throw new Error(`Invalid base branch: ${prMetadata.baseBranch}`);
    }
    if (!/^[0-9a-f]{40,64}$/i.test(prMetadata.baseSha)) {
      throw new Error(`Invalid base SHA: ${prMetadata.baseSha}`);
    }

    const isSameRepo = await detectSameRepoCheckout(repoDir, prMetadata);

    if (isSameRepo) {
      const sameRepoResult = await prepareSameRepoWorktree({
        repoDir,
        prMetadata,
        fetchRefStr,
        localPath,
        sessionDir,
        getWorktreePool: () => worktreePool,
      });
      worktreeCleanup = sameRepoResult.worktreeCleanup;
      exitHandler = sameRepoResult.exitHandler;
    } else {
      const crossRepoResult = await prepareCrossRepoWorktree({
        prMetadata,
        fetchRefStr,
        localPath,
        sessionDir,
      });
      worktreeCleanup = crossRepoResult.worktreeCleanup;
      exitHandler = crossRepoResult.exitHandler;
    }
    process.once("exit", exitHandler);

    worktreePool = createWorktreePool(
      { sessionDir, repoDir, isSameRepo },
      { path: localPath, prUrl: prMetadata.url, number: prNumber, ready: true },
    );
    console.error(`Local checkout ready at ${localPath}`);
    return { agentCwd: localPath, worktreeCleanup, worktreePool };
  } catch (err) {
    console.error("Warning: local worktree creation failed, falling back to remote diff");
    console.error(errorMessage(err));
    if (exitHandler !== undefined) {
      process.removeListener("exit", exitHandler);
    }
    if (sessionDir !== undefined) {
      try {
        rmSync(sessionDir, { recursive: true, force: true });
      } catch {}
    }
    return {};
  }
}

export async function openCodeReview(
  ctx: ExtensionContext,
  options: {
    cwd?: string;
    defaultBranch?: string;
    diffType?: DiffType;
    prUrl?: string;
    vcsType?: VcsSelection;
    useLocal?: boolean;
  } = {},
): Promise<{
  approved: boolean;
  feedback?: string;
  annotations?: unknown[];
  agentSwitch?: string;
  exit?: boolean;
}> {
  const session = await startCodeReviewBrowserSession(ctx, options);
  return session.waitForDecision();
}

export async function startCodeReviewBrowserSession(
  ctx: ExtensionContext,
  options: {
    cwd?: string;
    defaultBranch?: string;
    diffType?: DiffType;
    prUrl?: string;
    vcsType?: VcsSelection;
    useLocal?: boolean;
  } = {},
): Promise<
  BrowserDecisionSession<{
    approved: boolean;
    feedback?: string;
    annotations?: unknown[];
    agentSwitch?: string;
    exit?: boolean;
  }>
> {
  if (!ctx.hasUI || !reviewHtmlContent) {
    throw new Error("Plannotator code review browser is unavailable in this session.");
  }

  const urlArg = options.prUrl;
  const isPRMode =
    urlArg !== undefined &&
    urlArg.length > 0 &&
    (urlArg.startsWith("http://") || urlArg.startsWith("https://"));

  const sessionResult =
    isPRMode && urlArg !== undefined
      ? await createPrReviewSession(ctx, urlArg, options)
      : await createLocalReviewSession(ctx, options);

  let agentCwd = sessionResult.agentCwd;
  let worktreeCleanup = sessionResult.worktreeCleanup;
  let worktreePool = sessionResult.worktreePool;
  let prMetadata = sessionResult.prMetadata;

  if (sessionResult.prMetadata !== undefined && shouldUseLocalPrCheckout(options)) {
    const localCheckout = await createLocalPrCheckout(ctx, options, sessionResult.prMetadata);
    agentCwd = localCheckout.agentCwd;
    worktreeCleanup = localCheckout.worktreeCleanup;
    worktreePool = localCheckout.worktreePool;
  }

  const server = await startReviewServer({
    rawPatch: sessionResult.rawPatch,
    gitRef: sessionResult.gitRef,
    error: sessionResult.diffError,
    origin: "pi",
    diffType: sessionResult.diffType,
    gitContext: sessionResult.gitContext,
    initialBase: sessionResult.initialBase,
    prMetadata,
    agentCwd,
    worktreePool,
    htmlContent: reviewHtmlContent,
    sharingEnabled: process.env.PLANNOTATOR_SHARE !== "disabled",
    shareBaseUrl: process.env.PLANNOTATOR_SHARE_URL ?? undefined,
    pasteApiUrl: process.env.PLANNOTATOR_PASTE_URL ?? undefined,
    onCleanup: worktreeCleanup,
  });

  return startBrowserDecisionSession(server, ctx, server.waitForDecision);
}

export async function openMarkdownAnnotation(
  ctx: ExtensionContext,
  filePath: string,
  markdown: string,
  mode: AnnotateMode,
  folderPath?: string,
  sourceInfo?: string,
  sourceConverted?: boolean,
  gate?: boolean,
): Promise<{ feedback: string; exit?: boolean; approved?: boolean }> {
  const session = await startMarkdownAnnotationSession(
    ctx,
    filePath,
    markdown,
    mode,
    folderPath,
    sourceInfo,
    sourceConverted,
    gate,
  );
  return session.waitForDecision();
}

export async function startMarkdownAnnotationSession(
  ctx: ExtensionContext,
  filePath: string,
  markdown: string,
  mode: AnnotateMode,
  folderPath?: string,
  sourceInfo?: string,
  sourceConverted?: boolean,
  gate?: boolean,
  rawHtml?: string,
  renderHtml?: boolean,
): Promise<BrowserDecisionSession<{ feedback: string; exit?: boolean; approved?: boolean }>> {
  if (!ctx.hasUI || !planHtmlContent) {
    throw new Error("Plannotator annotation browser is unavailable in this session.");
  }

  let resolvedMarkdown = markdown;
  if (renderHtml !== true && !resolvedMarkdown.trim() && existsSync(filePath)) {
    try {
      const fileStat = statSync(filePath);
      if (!fileStat.isDirectory()) {
        resolvedMarkdown = readFileSync(filePath, "utf-8");
      }
    } catch {
      // fall back to provided markdown
    }
  }

  const server = await startAnnotateServer({
    markdown: resolvedMarkdown,
    filePath,
    origin: "pi",
    mode,
    folderPath,
    sourceInfo,
    sourceConverted,
    gate,
    rawHtml,
    renderHtml,
    htmlContent: planHtmlContent,
    sharingEnabled: process.env.PLANNOTATOR_SHARE !== "disabled",
    shareBaseUrl: process.env.PLANNOTATOR_SHARE_URL ?? undefined,
    pasteApiUrl: process.env.PLANNOTATOR_PASTE_URL ?? undefined,
  });

  return startBrowserDecisionSession(server, ctx, server.waitForDecision);
}

export function openLastMessageAnnotation(
  ctx: ExtensionContext,
  lastText: string,
  gate?: boolean,
): Promise<{ feedback: string; exit?: boolean; approved?: boolean }> {
  return openMarkdownAnnotation(
    ctx,
    "last-message",
    lastText,
    "annotate-last",
    undefined,
    undefined,
    undefined,
    gate,
  );
}

export function startLastMessageAnnotationSession(
  ctx: ExtensionContext,
  lastText: string,
  gate?: boolean,
): Promise<BrowserDecisionSession<{ feedback: string; exit?: boolean; approved?: boolean }>> {
  return startMarkdownAnnotationSession(
    ctx,
    "last-message",
    lastText,
    "annotate-last",
    undefined,
    undefined,
    undefined,
    gate,
  );
}

export async function openArchiveBrowserAction(
  ctx: ExtensionContext,
  customPlanPath?: string,
): Promise<{ opened: boolean }> {
  if (!ctx.hasUI || !planHtmlContent) {
    throw new Error("Plannotator archive browser is unavailable in this session.");
  }

  const server = await startPlanReviewServer({
    plan: "",
    htmlContent: planHtmlContent,
    origin: "pi",
    mode: "archive",
    customPlanPath,
    sharingEnabled: process.env.PLANNOTATOR_SHARE !== "disabled",
    shareBaseUrl: process.env.PLANNOTATOR_SHARE_URL ?? undefined,
    pasteApiUrl: process.env.PLANNOTATOR_PASTE_URL ?? undefined,
  });

  return openBrowserAndWait(server, ctx, async () => {
    if (server.waitForDone) {
      await server.waitForDone();
    }
    return { opened: true };
  });
}
