import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { BorderedLoader, DynamicBorder } from "@mariozechner/pi-coding-agent";
import {
  Container,
  fuzzyFilter,
  Input,
  type SelectItem,
  SelectList,
  Spacer,
  Text,
} from "@mariozechner/pi-tui";

import { installChildBootstrap, isChildSession } from "../../subagent-sdk/bootstrap.js";
import { buildLaunchCommand, readChildState } from "../../subagent-sdk/launch.js";
import { createDefaultSubagentRuntimeHooks } from "../../subagent-sdk/runtime-hooks.js";
import { createSubagentSDK } from "../../subagent-sdk/sdk.js";
import { TmuxAdapter } from "../../subagent-sdk/tmux.js";
import { SUBAGENT_STATUS_MESSAGE } from "../../subagent-sdk/types.js";
import { copyTextToClipboard } from "../../utils/clipboard.js";
import {
  generateContextTransferSummary,
  generateContextTransferSummaryWithLoader,
  getConversationMessages,
  type SummaryGenerationResult,
} from "../session-launch-utils.js";
import { launchHandoffSession, type HandoffLaunchResult } from "../handoff.js";
import {
  GH_SETUP_INSTRUCTIONS,
  PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE,
  REVIEW_ADDRESS_FINDINGS_PROMPT,
  REVIEW_ANCHOR_TYPE,
  REVIEW_HANDOFF_GENERATION_FAILED_MESSAGE,
  REVIEW_PRESETS,
  REVIEW_SETTINGS_TYPE,
  REVIEW_STATE_TYPE,
  TOGGLE_CUSTOM_INSTRUCTIONS_VALUE,
} from "./constants.js";
import { buildReviewAuthorTask, buildReviewHandoffPrompt } from "./handoff.js";
import { loadProjectReviewGuidelines } from "./guidelines.js";
import {
  checkoutPr,
  getCurrentBranch,
  getCurrentCheckoutTarget,
  getDefaultBranch,
  getLocalBranches,
  getPrInfo,
  getRecentCommits,
  hasPendingChanges,
  hasUncommittedChanges,
  restoreCheckoutTarget,
} from "./git.js";
import { parseArgs, parsePrReference, parseReviewPaths } from "./parsing.js";
import { buildReviewPrompt, getUserFacingHint } from "./prompts.js";
import { getReviewArgumentCompletions } from "./autocomplete.js";
import {
  getReviewSettings,
  getReviewState,
  isReviewStateActiveOnBranch,
  isTerminalReviewStatus,
  setReviewWidget,
} from "./state.js";
import type {
  CreateReviewExtensionOptions,
  ParsedReviewArgs,
  ReviewCheckoutTarget,
  ReviewSessionState,
  ReviewSettingsState,
  ReviewTarget,
} from "./types.js";

export {
  buildReviewHandoffPrompt,
  isReviewStateActiveOnBranch,
  loadProjectReviewGuidelines,
  parsePrReference,
  parseReviewPaths,
};

export function createReviewExtension(options: CreateReviewExtensionOptions = { enabled: true }) {
  return function reviewExtension(pi: ExtensionAPI): void {
    if (options.enabled === false) {
      return;
    }

    installChildBootstrap(pi);

    const defaultSubagentHooks = createDefaultSubagentRuntimeHooks(pi);
    const reviewSubagentHooks = {
      ...defaultSubagentHooks,
      emitStatusMessage({ content }: { content: string; triggerTurn?: boolean }) {
        pi.sendMessage(
          {
            customType: SUBAGENT_STATUS_MESSAGE,
            content,
            display: true,
          },
          { deliverAs: "steer", triggerTurn: false },
        );
      },
    };

    async function generateReviewHandoff(input: {
      ctx: ExtensionCommandContext;
      goal: string;
      messages: ReturnType<typeof getConversationMessages>;
    }): Promise<SummaryGenerationResult> {
      if (options.handoffGenerator) {
        return options.handoffGenerator(input);
      }

      return input.ctx.hasUI
        ? await generateContextTransferSummaryWithLoader(
            input.ctx,
            input.goal,
            input.messages,
            "Generating review handoff...",
          )
        : await generateContextTransferSummary(input.ctx, input.goal, input.messages);
    }

    const adapter =
      options.adapterFactory?.(pi) ??
      new TmuxAdapter(
        (command, args, execOptions) => pi.exec(command, args, execOptions),
        process.cwd(),
      );
    let sdk = createSubagentSDK(pi, {
      adapter,
      buildLaunchCommand,
      hooks: reviewSubagentHooks,
    });
    let stopSdkEvents: (() => void) | undefined;

    const runtime = {
      ctx: undefined as ExtensionContext | undefined,
      active: false,
      subagentSessionId: undefined as string | undefined,
      targetLabel: undefined as string | undefined,
      branchAnchorId: undefined as string | undefined,
      checkoutToRestore: undefined as ReviewCheckoutTarget | undefined,
      customInstructions: undefined as string | undefined,
      completionNotifiedSessionId: undefined as string | undefined,
      commandActions: undefined as
        | {
            navigateTree: ExtensionCommandContext["navigateTree"];
            newSession: ExtensionCommandContext["newSession"];
          }
        | undefined,
    };

    function buildAddressReviewPrompt(summary: string): string {
      return `${REVIEW_ADDRESS_FINDINGS_PROMPT}\n\n## Review Summary\n${summary.trim()}`;
    }

    async function restoreCheckoutAfterFailedStart(
      ctx: ExtensionContext,
      checkoutToRestore: ReviewCheckoutTarget | undefined,
    ): Promise<void> {
      const restoreResult = await restoreCheckoutTarget(pi, checkoutToRestore);
      if (!restoreResult.success) {
        ctx.ui.notify(`Failed to restore checkout: ${restoreResult.error}`, "error");
      }
    }

    async function offerCompletionActions(
      ctx: ExtensionContext,
      summary: string,
      branchAnchorId?: string,
    ): Promise<void> {
      if (!ctx.hasUI || !summary.trim()) {
        return;
      }

      const prompt = buildAddressReviewPrompt(summary);
      const supportsFork = Boolean(
        runtime.commandActions?.navigateTree || options.reviewFixBranchNavigator,
      );
      const supportsHandoff = Boolean(runtime.commandActions?.newSession);
      const selectedAction = options.completionActionPicker
        ? await options.completionActionPicker({ ctx, summary })
        : await (async () => {
            const actions = ["Copy review summary", "Address the review"];
            if (supportsHandoff) {
              actions.push("Handoff and address the review");
            }
            if (supportsFork) {
              actions.push("Fork and address the review");
            }

            const choice = await ctx.ui.select("Review subagent finished:", actions);
            if (choice === undefined) {
              return undefined;
            }

            if (choice === "Copy review summary") {
              return "copy";
            }

            if (choice === "Address the review") {
              return "address";
            }

            if (choice === "Handoff and address the review") {
              return "handoff";
            }

            return "fork";
          })();
      if (selectedAction === undefined) {
        return;
      }

      if (selectedAction === "copy") {
        try {
          await (options.clipboardWriter ?? copyTextToClipboard)(summary);
          ctx.ui.notify("Copied review summary to clipboard.", "info");
        } catch (error) {
          ctx.ui.notify(
            `Failed to copy review summary: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }
        return;
      }

      if (selectedAction === "address") {
        pi.sendUserMessage(prompt, { deliverAs: "followUp" });
        return;
      }

      if (selectedAction === "handoff") {
        const newSession = runtime.commandActions?.newSession;
        if (!newSession) {
          ctx.ui.notify(
            "Review handoff is unavailable after session reload. Start a new handoff manually.",
            "error",
          );
          return;
        }

        const handoffGoal = `Please Address and fix the following findings:\n${summary.trim()}`;
        let handoffResult: HandoffLaunchResult;
        try {
          handoffResult = options.handoffAddressRunner
            ? await options.handoffAddressRunner({
                ctx,
                newSession,
                goal: handoffGoal,
              })
            : await launchHandoffSession({
                pi,
                ctx,
                newSession,
                goal: handoffGoal,
              });
        } catch (error) {
          ctx.ui.notify(
            `Failed to start review handoff: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
          return;
        }

        if (handoffResult.status === "cancelled") {
          ctx.ui.notify("New session cancelled", "info");
          return;
        }

        if (handoffResult.status === "error") {
          ctx.ui.notify(handoffResult.error, "error");
          return;
        }

        if (handoffResult.warning) {
          ctx.ui.notify(handoffResult.warning, "warning");
        }

        return;
      }

      const branchTargetId = branchAnchorId ?? null;
      if (!branchTargetId) {
        ctx.ui.notify(
          "Failed to create a review fix branch from the current session state.",
          "error",
        );
        return;
      }

      const navigateToReviewFixBranch = options.reviewFixBranchNavigator
        ? options.reviewFixBranchNavigator
        : async ({
            targetId,
            summarize,
            label,
          }: {
            ctx: ExtensionContext;
            targetId: string;
            summarize: boolean;
            label: string;
          }) => {
            if (!runtime.commandActions?.navigateTree) {
              throw new Error(
                "Forking review fixes is unavailable after session reload. Start a new session manually.",
              );
            }

            return runtime.commandActions.navigateTree(targetId, {
              summarize,
              label,
            });
          };

      try {
        const navigationResultPromise = navigateToReviewFixBranch({
          ctx,
          targetId: branchTargetId,
          summarize: true,
          label: "review-fixes",
        });
        const loaderResult = await ctx.ui.custom<
          { cancelled: boolean; error?: string } | undefined
        >((tui, theme, _kb, done) => {
          const loader = new BorderedLoader(tui, theme, "Forking review fixes with summary...");
          void navigationResultPromise
            .then((result) => done(result))
            .catch((error) => {
              done({
                cancelled: false,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          return loader;
        });
        const result = loaderResult ?? (await navigationResultPromise);
        if (result.cancelled) {
          return;
        }
        ctx.ui.notify("Forked review fixes into a new branch.", "info");
      } catch (error) {
        ctx.ui.notify(
          `Failed to create review fix branch: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        return;
      }

      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    }

    async function finalizeReview(
      ctx: ExtensionContext,
      status: "completed" | "failed" | "cancelled",
      summary?: string,
    ): Promise<void> {
      const checkoutToRestore = runtime.checkoutToRestore;
      const commandActions = runtime.commandActions;
      const branchAnchorId = runtime.branchAnchorId;
      clearReviewState(ctx);
      runtime.commandActions = commandActions;

      const restoreResult = await restoreCheckoutTarget(pi, checkoutToRestore);
      if (!restoreResult.success) {
        ctx.ui.notify(`Failed to restore checkout: ${restoreResult.error}`, "error");
      }

      ctx.ui.notify(
        status === "completed"
          ? "Review complete."
          : status === "cancelled"
            ? "Review cancelled."
            : "Review failed.",
        status === "completed" ? "info" : "warning",
      );

      if (status === "completed" && summary?.trim()) {
        await offerCompletionActions(ctx, summary, branchAnchorId);
      }

      runtime.commandActions = undefined;
    }

    function attachSdkEvents(): void {
      stopSdkEvents?.();
      stopSdkEvents = sdk.onEvent((event) => {
        if (!runtime.subagentSessionId || event.state.sessionId !== runtime.subagentSessionId) {
          return;
        }

        const ctx = runtime.ctx;
        if (!ctx) {
          return;
        }

        syncReviewWidget(ctx);
        if (
          isTerminalReviewStatus(event.state.status) &&
          runtime.completionNotifiedSessionId !== event.state.sessionId
        ) {
          runtime.completionNotifiedSessionId = event.state.sessionId;
          void finalizeReview(ctx, event.state.status, event.state.summary);
        }
      });
    }

    function resetSdk(): void {
      stopSdkEvents?.();
      stopSdkEvents = undefined;
      sdk.dispose();
      sdk = createSubagentSDK(pi, {
        adapter,
        buildLaunchCommand,
        hooks: reviewSubagentHooks,
      });
      attachSdkEvents();
    }

    attachSdkEvents();

    function persistReviewSettings(): void {
      pi.appendEntry(REVIEW_SETTINGS_TYPE, {
        customInstructions: runtime.customInstructions,
      } satisfies ReviewSettingsState);
    }

    function setReviewCustomInstructions(instructions: string | undefined): void {
      runtime.customInstructions = instructions?.trim() || undefined;
      persistReviewSettings();
    }

    function trackedReviewState() {
      if (!runtime.subagentSessionId) {
        return undefined;
      }

      return sdk.get(runtime.subagentSessionId)?.getState();
    }

    function reviewStatusText(): string | undefined {
      const state = trackedReviewState();
      if (!state) {
        return undefined;
      }

      if (state.status === "running") {
        return "running";
      }
      if (state.status === "idle") {
        return "waiting for completion summary";
      }
      if (state.status === "completed") {
        return "completing";
      }
      if (state.status === "failed") {
        return "failed, review output captured";
      }
      if (state.status === "cancelled") {
        return "cancelled";
      }

      return state.status;
    }

    function syncReviewWidget(ctx: ExtensionContext): void {
      if (!runtime.active) {
        setReviewWidget(ctx, undefined);
        return;
      }

      setReviewWidget(ctx, {
        targetLabel: runtime.targetLabel,
        statusText: reviewStatusText(),
      });
    }

    function applyReviewSettings(ctx: ExtensionContext): void {
      runtime.customInstructions = getReviewSettings(ctx).customInstructions;
    }

    function applyReviewState(ctx: ExtensionContext): void {
      const previousSessionId = runtime.subagentSessionId;
      const state = getReviewState(ctx);
      const activeState = isReviewStateActiveOnBranch(state, ctx.sessionManager.getBranch())
        ? state
        : undefined;
      runtime.active = Boolean(activeState?.active);
      runtime.subagentSessionId = activeState?.subagentSessionId;
      runtime.targetLabel = activeState?.targetLabel;
      runtime.branchAnchorId = activeState?.branchAnchorId;
      runtime.checkoutToRestore = activeState?.checkoutToRestore;
      if (previousSessionId && previousSessionId !== runtime.subagentSessionId) {
        resetSdk();
      }
      if (!activeState?.active) {
        runtime.completionNotifiedSessionId = undefined;
      }
      syncReviewWidget(ctx);
    }

    async function restoreTrackedReviewSubagent(ctx: ExtensionContext): Promise<void> {
      if (!runtime.subagentSessionId || sdk.get(runtime.subagentSessionId)) {
        return;
      }

      if (isChildSession(readChildState(), ctx)) {
        return;
      }

      await sdk.restore(ctx);
    }

    async function applyAllReviewState(ctx: ExtensionContext): Promise<void> {
      runtime.ctx = ctx;
      applyReviewSettings(ctx);
      applyReviewState(ctx);
      try {
        await restoreTrackedReviewSubagent(ctx);
      } catch {
        return;
      }
      syncReviewWidget(ctx);
      if (runtime.active && isTrackedReviewTerminal()) {
        const terminalState = trackedReviewState();
        if (
          terminalState &&
          isTerminalReviewStatus(terminalState.status) &&
          runtime.completionNotifiedSessionId !== terminalState.sessionId
        ) {
          runtime.completionNotifiedSessionId = terminalState.sessionId;
          void finalizeReview(ctx, terminalState.status, terminalState.summary);
        }
      }
    }

    function persistReviewState(state: ReviewSessionState): void {
      pi.appendEntry(REVIEW_STATE_TYPE, state);
    }

    function clearReviewState(ctx: ExtensionContext): void {
      resetSdk();
      runtime.active = false;
      runtime.subagentSessionId = undefined;
      runtime.targetLabel = undefined;
      runtime.branchAnchorId = undefined;
      runtime.checkoutToRestore = undefined;
      runtime.completionNotifiedSessionId = undefined;
      runtime.commandActions = undefined;
      persistReviewState({ active: false });
      syncReviewWidget(ctx);
    }

    function isTrackedReviewTerminal(): boolean {
      const state = trackedReviewState();
      return Boolean(state && ["completed", "failed", "cancelled"].includes(state.status));
    }

    async function ensureGithubCliReady(ctx: ExtensionContext): Promise<boolean> {
      const version = await pi.exec("gh", ["--version"]);
      if (version.code !== 0) {
        ctx.ui.notify(`PR review requires GitHub CLI (\`gh\`). ${GH_SETUP_INSTRUCTIONS}`, "error");
        return false;
      }

      const authStatus = await pi.exec("gh", ["auth", "status"]);
      if (authStatus.code !== 0) {
        ctx.ui.notify(
          "GitHub CLI is installed, but you're not signed in. Run `gh auth login`, then verify with `gh auth status`.",
          "error",
        );
        return false;
      }

      return true;
    }

    async function resolvePullRequestTarget(
      ctx: ExtensionContext,
      ref: string,
      resolveOptions: { skipInitialPendingChangesCheck?: boolean } = {},
    ): Promise<ReviewTarget | null> {
      if (!(await ensureGithubCliReady(ctx))) {
        return null;
      }

      if (!resolveOptions.skipInitialPendingChangesCheck && (await hasPendingChanges(pi))) {
        ctx.ui.notify(PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE, "error");
        return null;
      }

      const parsedReference = parsePrReference(ref);
      if (!parsedReference) {
        ctx.ui.notify("Invalid PR reference. Enter a number or GitHub PR URL.", "error");
        return null;
      }
      const { prNumber, repo } = parsedReference;

      ctx.ui.notify(`Fetching PR #${prNumber} info...`, "info");
      const prInfo = await getPrInfo(pi, prNumber, repo);
      if (!prInfo) {
        ctx.ui.notify(
          `Could not fetch PR #${prNumber}. Make sure it exists and your GitHub auth has access.`,
          "error",
        );
        return null;
      }

      if (await hasPendingChanges(pi)) {
        ctx.ui.notify(PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE, "error");
        return null;
      }

      const checkoutToRestore = await getCurrentCheckoutTarget(pi);
      if (!checkoutToRestore) {
        ctx.ui.notify("Failed to determine the current checkout before PR review.", "error");
        return null;
      }

      ctx.ui.notify(`Checking out PR #${prNumber}...`, "info");
      const checkoutResult = await checkoutPr(pi, prNumber, repo);
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

    async function getSmartDefault(): Promise<"uncommitted" | "baseBranch" | "commit"> {
      if (await hasUncommittedChanges(pi)) {
        return "uncommitted";
      }

      const currentBranch = await getCurrentBranch(pi);
      const defaultBranch = await getDefaultBranch(pi);
      if (currentBranch && currentBranch !== defaultBranch) {
        return "baseBranch";
      }

      return "commit";
    }

    async function showBranchSelector(ctx: ExtensionContext): Promise<ReviewTarget | null> {
      const branches = await getLocalBranches(pi);
      const currentBranch = await getCurrentBranch(pi);
      const defaultBranch = await getDefaultBranch(pi);
      const candidateBranches = currentBranch
        ? branches.filter((branch) => branch !== currentBranch)
        : branches;
      if (candidateBranches.length === 0) {
        ctx.ui.notify(
          currentBranch
            ? `No other branches found (current branch: ${currentBranch})`
            : "No branches found",
          "error",
        );
        return null;
      }

      const items: SelectItem[] = candidateBranches
        .slice()
        .sort((left, right) => {
          if (left === defaultBranch) return -1;
          if (right === defaultBranch) return 1;
          return left.localeCompare(right);
        })
        .map((branch) => ({
          value: branch,
          label: branch,
          description: branch === defaultBranch ? "(default)" : "",
        }));

      const result = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
        container.addChild(new Text(theme.fg("accent", theme.bold("Select base branch"))));

        const searchInput = new Input();
        container.addChild(searchInput);
        container.addChild(new Spacer(1));

        const listContainer = new Container();
        container.addChild(listContainer);
        container.addChild(
          new Text(theme.fg("dim", "Type to filter • enter to select • esc to cancel")),
        );
        container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

        let filteredItems = items;
        let selectList: SelectList | null = null;

        const updateList = () => {
          listContainer.clear();
          if (filteredItems.length === 0) {
            listContainer.addChild(new Text(theme.fg("warning", "  No matching branches")));
            selectList = null;
            return;
          }

          selectList = new SelectList(filteredItems, Math.min(filteredItems.length, 10), {
            selectedPrefix: (text) => theme.fg("accent", text),
            selectedText: (text) => theme.fg("accent", text),
            description: (text) => theme.fg("muted", text),
            scrollInfo: (text) => theme.fg("dim", text),
            noMatch: (text) => theme.fg("warning", text),
          });
          selectList.onSelect = (item) => done(item.value);
          selectList.onCancel = () => done(null);
          listContainer.addChild(selectList);
        };

        const applyFilter = () => {
          const query = searchInput.getValue();
          filteredItems = query
            ? fuzzyFilter(
                items,
                query,
                (item) => `${item.label} ${item.value} ${item.description ?? ""}`,
              )
            : items;
          updateList();
        };

        applyFilter();

        return {
          render(width: number) {
            return container.render(width);
          },
          invalidate() {
            container.invalidate();
          },
          handleInput(data: string) {
            if (
              keybindings.matches(data, "tui.select.up") ||
              keybindings.matches(data, "tui.select.down") ||
              keybindings.matches(data, "tui.select.confirm") ||
              keybindings.matches(data, "tui.select.cancel")
            ) {
              if (selectList) {
                selectList.handleInput(data);
              } else if (keybindings.matches(data, "tui.select.cancel")) {
                done(null);
              }
              tui.requestRender();
              return;
            }

            searchInput.handleInput(data);
            applyFilter();
            tui.requestRender();
          },
        };
      });

      return result ? { type: "baseBranch", branch: result } : null;
    }

    async function showCommitSelector(ctx: ExtensionContext): Promise<ReviewTarget | null> {
      const commits = await getRecentCommits(pi);
      if (commits.length === 0) {
        ctx.ui.notify("No commits found", "error");
        return null;
      }

      const items: SelectItem[] = commits.map((commit) => ({
        value: commit.sha,
        label: `${commit.sha.slice(0, 7)} ${commit.title}`,
        description: "",
      }));

      const result = await ctx.ui.custom<{ sha: string; title: string } | null>(
        (tui, theme, keybindings, done) => {
          const container = new Container();
          container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
          container.addChild(new Text(theme.fg("accent", theme.bold("Select commit to review"))));

          const searchInput = new Input();
          container.addChild(searchInput);
          container.addChild(new Spacer(1));

          const listContainer = new Container();
          container.addChild(listContainer);
          container.addChild(
            new Text(theme.fg("dim", "Type to filter • enter to select • esc to cancel")),
          );
          container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

          let filteredItems = items;
          let selectList: SelectList | null = null;

          const updateList = () => {
            listContainer.clear();
            if (filteredItems.length === 0) {
              listContainer.addChild(new Text(theme.fg("warning", "  No matching commits")));
              selectList = null;
              return;
            }

            selectList = new SelectList(filteredItems, Math.min(filteredItems.length, 10), {
              selectedPrefix: (text) => theme.fg("accent", text),
              selectedText: (text) => theme.fg("accent", text),
              description: (text) => theme.fg("muted", text),
              scrollInfo: (text) => theme.fg("dim", text),
              noMatch: (text) => theme.fg("warning", text),
            });
            selectList.onSelect = (item) => {
              const commit = commits.find((candidate) => candidate.sha === item.value);
              done(commit ?? null);
            };
            selectList.onCancel = () => done(null);
            listContainer.addChild(selectList);
          };

          const applyFilter = () => {
            const query = searchInput.getValue();
            filteredItems = query
              ? fuzzyFilter(
                  items,
                  query,
                  (item) => `${item.label} ${item.value} ${item.description ?? ""}`,
                )
              : items;
            updateList();
          };

          applyFilter();

          return {
            render(width: number) {
              return container.render(width);
            },
            invalidate() {
              container.invalidate();
            },
            handleInput(data: string) {
              if (
                keybindings.matches(data, "tui.select.up") ||
                keybindings.matches(data, "tui.select.down") ||
                keybindings.matches(data, "tui.select.confirm") ||
                keybindings.matches(data, "tui.select.cancel")
              ) {
                if (selectList) {
                  selectList.handleInput(data);
                } else if (keybindings.matches(data, "tui.select.cancel")) {
                  done(null);
                }
                tui.requestRender();
                return;
              }

              searchInput.handleInput(data);
              applyFilter();
              tui.requestRender();
            },
          };
        },
      );

      return result ? { type: "commit", sha: result.sha, title: result.title } : null;
    }

    async function showFolderInput(ctx: ExtensionContext): Promise<ReviewTarget | null> {
      const result = await ctx.ui.editor(
        "Enter folders or files to review (space-separated or one per line):",
        ".",
      );
      if (!result?.trim()) {
        return null;
      }

      const paths = parseReviewPaths(result);
      return paths.length > 0 ? { type: "folder", paths } : null;
    }

    async function showPrInput(ctx: ExtensionContext): Promise<ReviewTarget | null> {
      if (await hasPendingChanges(pi)) {
        ctx.ui.notify(PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE, "error");
        return null;
      }

      const prRef = await ctx.ui.editor(
        "Enter PR number or URL (for example 123 or https://github.com/owner/repo/pull/123):",
        "",
      );
      if (!prRef?.trim()) {
        return null;
      }

      return resolvePullRequestTarget(ctx, prRef, { skipInitialPendingChangesCheck: true });
    }

    async function showReviewSelector(ctx: ExtensionContext): Promise<ReviewTarget | null> {
      const smartDefault = await getSmartDefault();
      const presetItems: SelectItem[] = REVIEW_PRESETS.map((preset) => ({
        value: preset.value,
        label: preset.label,
        description: preset.description,
      }));
      const smartDefaultIndex = presetItems.findIndex((item) => item.value === smartDefault);

      while (true) {
        const items: SelectItem[] = [
          ...presetItems,
          {
            value: TOGGLE_CUSTOM_INSTRUCTIONS_VALUE,
            label: runtime.customInstructions
              ? "Remove custom review instructions"
              : "Add custom review instructions",
            description: runtime.customInstructions
              ? "(currently set)"
              : "(applies to all review modes)",
          },
        ];

        const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
          const container = new Container();
          container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
          container.addChild(new Text(theme.fg("accent", theme.bold("Select a review preset"))));

          const selectList = new SelectList(items, Math.min(items.length, 10), {
            selectedPrefix: (text) => theme.fg("accent", text),
            selectedText: (text) => theme.fg("accent", text),
            description: (text) => theme.fg("muted", text),
            scrollInfo: (text) => theme.fg("dim", text),
            noMatch: (text) => theme.fg("warning", text),
          });
          if (smartDefaultIndex >= 0) {
            selectList.setSelectedIndex(smartDefaultIndex);
          }

          selectList.onSelect = (item) => done(item.value);
          selectList.onCancel = () => done(null);

          container.addChild(selectList);
          container.addChild(new Text(theme.fg("dim", "Press enter to confirm or esc to cancel")));
          container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

          return {
            render(width: number) {
              return container.render(width);
            },
            invalidate() {
              container.invalidate();
            },
            handleInput(data: string) {
              selectList.handleInput(data);
              tui.requestRender();
            },
          };
        });

        if (!result) {
          return null;
        }

        if (result === TOGGLE_CUSTOM_INSTRUCTIONS_VALUE) {
          if (runtime.customInstructions) {
            setReviewCustomInstructions(undefined);
            ctx.ui.notify("Custom review instructions removed", "info");
            continue;
          }

          const editedInstructions = await ctx.ui.editor(
            "Enter custom review instructions (applies to all review modes):",
            "",
          );
          if (!editedInstructions?.trim()) {
            ctx.ui.notify("Custom review instructions not changed", "info");
            continue;
          }

          setReviewCustomInstructions(editedInstructions);
          ctx.ui.notify("Custom review instructions saved", "info");
          continue;
        }

        if (result === "uncommitted") {
          return { type: "uncommitted" };
        }
        if (result === "baseBranch") {
          const target = await showBranchSelector(ctx);
          if (target) return target;
          continue;
        }
        if (result === "commit") {
          const target = await showCommitSelector(ctx);
          if (target) return target;
          continue;
        }
        if (result === "folder") {
          const target = await showFolderInput(ctx);
          if (target) return target;
          continue;
        }
        if (result === "pullRequest") {
          const target = await showPrInput(ctx);
          if (target) return target;
          continue;
        }
      }
    }

    async function executeReview(
      ctx: ExtensionCommandContext,
      target: ReviewTarget,
      options: {
        extraInstruction?: string;
        handoffRequested?: boolean;
        handoffInstruction?: string;
      } = {},
    ): Promise<boolean> {
      if (runtime.active) {
        ctx.ui.notify("A review is already running. Wait for it to finish first.", "warning");
        return false;
      }

      const checkoutToRestore =
        target.type === "pullRequest" ? target.checkoutToRestore : undefined;

      const prompt = await buildReviewPrompt(pi, target);
      const targetLabel = getUserFacingHint(target);
      const projectGuidelines = await loadProjectReviewGuidelines(ctx.cwd);
      const parentSessionPath = ctx.sessionManager.getSessionFile();
      const parentMessages = getConversationMessages(ctx);

      let generatedHandoffPrompt: string | undefined;
      if (options.handoffRequested) {
        if (parentMessages.length > 0) {
          const handoffGoal = [
            `Prepare a reviewer handoff for reviewing ${targetLabel}.`,
            "Summarize the implementation intent, risky areas, tradeoffs, open questions, and anything the reviewer should challenge or validate.",
            options.handoffInstruction?.trim()
              ? `Additional author handoff request: ${options.handoffInstruction.trim()}`
              : undefined,
          ]
            .filter((value): value is string => Boolean(value))
            .join("\n\n");
          const handoffResult = await generateReviewHandoff({
            ctx,
            goal: handoffGoal,
            messages: parentMessages,
          });

          if (handoffResult.error) {
            await restoreCheckoutAfterFailedStart(ctx, checkoutToRestore);
            ctx.ui.notify(REVIEW_HANDOFF_GENERATION_FAILED_MESSAGE, "error");
            ctx.ui.notify(handoffResult.error, "error");
            return false;
          }
          if (handoffResult.aborted || !handoffResult.summary) {
            await restoreCheckoutAfterFailedStart(ctx, checkoutToRestore);
            ctx.ui.notify("Review cancelled", "info");
            return false;
          }

          generatedHandoffPrompt = buildReviewHandoffPrompt({
            summary: handoffResult.summary,
            targetLabel,
            handoffInstruction: options.handoffInstruction,
            parentSessionPath,
          });
        } else if (options.handoffInstruction?.trim()) {
          generatedHandoffPrompt = `## Task\n${buildReviewAuthorTask(targetLabel, options.handoffInstruction)}`;
        } else {
          ctx.ui.notify("No session history available for automatic review handoff.", "warning");
        }
      }

      const promptSections = [
        `Review target:\n- ${targetLabel}`,
        `Review instructions:\n${prompt}`,
        runtime.customInstructions?.trim()
          ? `Shared custom review instructions:\n${runtime.customInstructions.trim()}`
          : undefined,
        options.extraInstruction?.trim()
          ? `Additional user-provided review instruction:\n${options.extraInstruction.trim()}`
          : undefined,
        generatedHandoffPrompt ? `Author handoff:\n${generatedHandoffPrompt}` : undefined,
        projectGuidelines ? `Project review guidelines:\n${projectGuidelines}` : undefined,
      ].filter((value): value is string => Boolean(value));

      const fullPrompt = [
        "Please perform a code review using the built-in review mode.",
        ...promptSections,
        "Return findings in the required review format.",
      ].join("\n\n");

      pi.appendEntry(REVIEW_ANCHOR_TYPE, {
        targetLabel,
        createdAt: new Date().toISOString(),
      });
      const branchAnchorId = ctx.sessionManager.getLeafId() ?? undefined;

      ctx.ui.notify(`Starting review: ${targetLabel}`, "info");

      try {
        const started = await sdk.spawn(
          {
            name: "review",
            task: fullPrompt,
            mode: "review",
            cwd: ctx.cwd,
          },
          ctx,
        );

        if (!started.ok) {
          throw new Error(started.error.message);
        }

        const startedValue = started.value;

        runtime.active = true;
        runtime.subagentSessionId = startedValue.handle.sessionId;
        runtime.targetLabel = targetLabel;
        runtime.branchAnchorId = branchAnchorId;
        runtime.checkoutToRestore = checkoutToRestore;
        runtime.completionNotifiedSessionId = undefined;
        runtime.commandActions = {
          navigateTree: ctx.navigateTree,
          newSession: (options) => ctx.newSession(options),
        };
        persistReviewState({
          active: true,
          subagentSessionId: startedValue.handle.sessionId,
          targetLabel,
          branchAnchorId,
          checkoutToRestore,
        });
        syncReviewWidget(ctx);
        return true;
      } catch (error) {
        const restoreResult = await restoreCheckoutTarget(pi, checkoutToRestore);
        if (!restoreResult.success) {
          ctx.ui.notify(`Failed to restore checkout: ${restoreResult.error}`, "error");
        }
        clearReviewState(ctx);
        ctx.ui.notify(
          `Failed to start review: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        return false;
      }
    }

    async function resolveRequestedTarget(
      ctx: ExtensionCommandContext,
      requestedTargetType: ParsedReviewArgs["requestedTargetType"],
    ): Promise<ReviewTarget | null> {
      if (requestedTargetType === "uncommitted") {
        return { type: "uncommitted" };
      }
      if (requestedTargetType === "branch") {
        return showBranchSelector(ctx);
      }
      if (requestedTargetType === "commit") {
        return showCommitSelector(ctx);
      }
      if (requestedTargetType === "folder") {
        return showFolderInput(ctx);
      }
      if (requestedTargetType === "pr") {
        return showPrInput(ctx);
      }

      return null;
    }

    async function handlePrCheckout(
      ctx: ExtensionContext,
      ref: string,
    ): Promise<ReviewTarget | null> {
      return resolvePullRequestTarget(ctx, ref);
    }

    pi.on("session_start", async (_event, ctx) => {
      await applyAllReviewState(ctx);
    });

    pi.on("session_tree", async (_event, ctx) => {
      await applyAllReviewState(ctx);
    });

    pi.on("session_shutdown", async () => {
      stopSdkEvents?.();
      sdk.dispose();
    });

    pi.registerCommand("review", {
      description: "Review code changes using the built-in review mode",
      getArgumentCompletions: (prefix) => getReviewArgumentCompletions(pi, prefix),
      handler: async (args, ctx) => {
        if (!ctx.hasUI) {
          ctx.ui.notify("Review requires interactive mode", "error");
          return;
        }

        if (runtime.active) {
          ctx.ui.notify("A review is already running. Wait for it to finish first.", "warning");
          return;
        }

        const gitCheck = await pi.exec("git", ["rev-parse", "--git-dir"]);
        if (gitCheck.code !== 0) {
          ctx.ui.notify("Not a git repository", "error");
          return;
        }

        let target: ReviewTarget | null = null;
        let fromSelector = false;
        const parsed = parseArgs(args);
        if (parsed.error) {
          ctx.ui.notify(parsed.error, "error");
          return;
        }

        if (parsed.target) {
          if (parsed.target.type === "pr") {
            target = await handlePrCheckout(ctx, parsed.target.ref);
            if (!target) {
              ctx.ui.notify("PR review failed. Returning to review menu.", "warning");
              return;
            }
          } else {
            target = parsed.target;
          }
        }

        if (!target && parsed.requestedTargetType) {
          target = await resolveRequestedTarget(ctx, parsed.requestedTargetType);
        } else if (!target) {
          fromSelector = true;
        }

        while (true) {
          if (!target && fromSelector) {
            target = await showReviewSelector(ctx);
          }

          if (!target) {
            ctx.ui.notify("Review cancelled", "info");
            return;
          }

          const started = await executeReview(ctx, target, {
            extraInstruction: parsed.extraInstruction?.trim() || undefined,
            handoffRequested: parsed.handoffRequested,
            handoffInstruction: parsed.handoffInstruction?.trim() || undefined,
          });
          if (started) {
            return;
          }

          if (!fromSelector) {
            return;
          }

          target = null;
        }
      },
    });
  };
}

export default createReviewExtension();
