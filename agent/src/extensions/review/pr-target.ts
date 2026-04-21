import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ReviewCheckoutTarget, ReviewTarget } from "./deps.js";

type ResolvePullRequestTargetDeps = {
  pi: Pick<ExtensionAPI, "exec">;
  ghSetupInstructions: string;
  pendingChangesBlockedMessage: string;
  hasPendingChanges: () => Promise<boolean>;
  parsePrReference: (ref: string) => { prNumber: number; repo?: string } | null;
  getPrInfo: (
    prNumber: number,
    repo?: string,
  ) => Promise<{ baseBranch: string; title: string; headBranch: string } | null | undefined>;
  getCurrentCheckoutTarget: () => Promise<ReviewCheckoutTarget | null | undefined>;
  checkoutPr: (prNumber: number, repo?: string) => Promise<{ success: boolean; error?: string }>;
};

async function ensureGithubCliReady(
  ctx: ExtensionContext,
  deps: ResolvePullRequestTargetDeps,
): Promise<boolean> {
  const version = await deps.pi.exec("gh", ["--version"]);
  if (version.code !== 0) {
    ctx.ui.notify(`PR review requires GitHub CLI (\`gh\`). ${deps.ghSetupInstructions}`, "error");
    return false;
  }

  const authStatus = await deps.pi.exec("gh", ["auth", "status"]);
  if (authStatus.code !== 0) {
    ctx.ui.notify(
      "GitHub CLI is installed, but you're not signed in. Run `gh auth login`, then verify with `gh auth status`.",
      "error",
    );
    return false;
  }

  return true;
}

async function ensureNoPendingChangesForPrCheckout(
  ctx: ExtensionContext,
  deps: ResolvePullRequestTargetDeps,
): Promise<boolean> {
  if (await deps.hasPendingChanges()) {
    ctx.ui.notify(deps.pendingChangesBlockedMessage, "error");
    return false;
  }

  return true;
}

async function resolvePullRequestInfo(
  ctx: ExtensionContext,
  ref: string,
  deps: ResolvePullRequestTargetDeps,
): Promise<{
  prNumber: number;
  repo: string | undefined;
  prInfo: { baseBranch: string; title: string; headBranch: string };
} | null> {
  const parsedReference = deps.parsePrReference(ref);
  if (!parsedReference) {
    ctx.ui.notify("Invalid PR reference. Enter a number or GitHub PR URL.", "error");
    return null;
  }

  const { prNumber, repo } = parsedReference;
  ctx.ui.notify(`Fetching PR #${prNumber} info...`, "info");
  const prInfo = await deps.getPrInfo(prNumber, repo);
  if (!prInfo) {
    ctx.ui.notify(
      `Could not fetch PR #${prNumber}. Make sure it exists and your GitHub auth has access.`,
      "error",
    );
    return null;
  }

  return { prNumber, repo, prInfo };
}

export async function resolvePullRequestTarget(
  ctx: ExtensionContext,
  ref: string,
  deps: ResolvePullRequestTargetDeps,
  resolveOptions: { skipInitialPendingChangesCheck?: boolean } = {},
): Promise<ReviewTarget | null> {
  if (!(await ensureGithubCliReady(ctx, deps))) {
    return null;
  }

  if (
    resolveOptions.skipInitialPendingChangesCheck !== true &&
    !(await ensureNoPendingChangesForPrCheckout(ctx, deps))
  ) {
    return null;
  }

  const pullRequestInfo = await resolvePullRequestInfo(ctx, ref, deps);
  if (!pullRequestInfo) {
    return null;
  }
  const { prNumber, repo, prInfo } = pullRequestInfo;

  if (!(await ensureNoPendingChangesForPrCheckout(ctx, deps))) {
    return null;
  }

  const checkoutToRestore = await deps.getCurrentCheckoutTarget();
  if (!checkoutToRestore) {
    ctx.ui.notify("Failed to determine the current checkout before PR review.", "error");
    return null;
  }

  ctx.ui.notify(`Checking out PR #${prNumber}...`, "info");
  const checkoutResult = await deps.checkoutPr(prNumber, repo);
  if (!checkoutResult.success) {
    ctx.ui.notify(`Failed to checkout PR: ${checkoutResult.error}`, "error");
    return null;
  }

  ctx.ui.notify(`Checked out PR #${prNumber} (${prInfo.headBranch})`, "info");
  return {
    type: "pullRequest",
    prNumber,
    baseBranch: prInfo.baseBranch,
    title: prInfo.title,
    checkoutToRestore,
  };
}
