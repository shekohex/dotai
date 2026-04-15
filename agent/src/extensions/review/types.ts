import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

import type { MuxAdapter } from "../../subagent-sdk/mux.js";
import type { HandoffLaunchResult } from "../handoff.js";
import {
  type SummaryGenerationResult,
  type getConversationMessages,
} from "../session-launch-utils.js";

export type CreateReviewExtensionOptions = {
  adapterFactory?: (pi: ExtensionAPI) => MuxAdapter;
  enabled?: boolean;
  handoffGenerator?: (input: {
    ctx: ExtensionCommandContext;
    goal: string;
    messages: ReturnType<typeof getConversationMessages>;
  }) => Promise<SummaryGenerationResult>;
  completionActionPicker?: (input: {
    ctx: ExtensionContext;
    summary: string;
  }) => Promise<"address" | "copy" | "fork" | "handoff" | undefined>;
  clipboardWriter?: (text: string) => Promise<void>;
  reviewFixBranchNavigator?: (input: {
    ctx: ExtensionContext;
    targetId: string;
    summarize: boolean;
    label: string;
  }) => Promise<{ cancelled: boolean }>;
  handoffAddressRunner?: (input: {
    ctx: ExtensionContext;
    newSession: ExtensionCommandContext["newSession"];
    goal: string;
  }) => Promise<HandoffLaunchResult>;
};

export type ReviewCheckoutTarget =
  | { type: "branch"; name: string }
  | { type: "detached"; commit: string };

export type ReviewTarget =
  | { type: "uncommitted" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string; title?: string }
  | {
      type: "pullRequest";
      prNumber: number;
      baseBranch: string;
      title: string;
      checkoutToRestore?: ReviewCheckoutTarget;
    }
  | { type: "folder"; paths: string[] };

export type ParsedPrReference = {
  prNumber: number;
  repo?: string;
};

export type ReviewRequestedTargetType = "uncommitted" | "branch" | "commit" | "pr" | "folder";

export type ParsedReviewArgs = {
  target: ReviewTarget | { type: "pr"; ref: string } | null;
  requestedTargetType?: ReviewRequestedTargetType;
  extraInstruction?: string;
  handoffRequested?: boolean;
  handoffInstruction?: string;
  error?: string;
};

export type ReviewSessionState = {
  active: boolean;
  subagentSessionId?: string;
  targetLabel?: string;
  branchAnchorId?: string;
  checkoutToRestore?: ReviewCheckoutTarget;
};

export type ReviewSettingsState = {
  customInstructions?: string;
};
