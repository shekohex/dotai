import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { REVIEW_SETTINGS_TYPE, REVIEW_STATE_TYPE, REVIEW_WIDGET_KEY } from "./constants.js";
import type { ReviewSessionState, ReviewSettingsState } from "./types.js";

const ReviewSessionStateSchema = Type.Object(
  {
    active: Type.Boolean(),
    branchAnchorId: Type.Optional(Type.String()),
    subagentSessionId: Type.Optional(Type.String()),
    targetLabel: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

const ReviewSettingsStateSchema = Type.Object(
  {
    customInstructions: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

function readReviewSessionState(value: unknown): ReviewSessionState | undefined {
  if (!Value.Check(ReviewSessionStateSchema, value)) {
    return undefined;
  }
  const { active, branchAnchorId, subagentSessionId, targetLabel } = Value.Parse(
    ReviewSessionStateSchema,
    value,
  );

  return {
    active,
    subagentSessionId,
    branchAnchorId,
    targetLabel,
    checkoutToRestore: undefined,
  };
}

function readReviewSettingsState(value: unknown): ReviewSettingsState | undefined {
  if (!Value.Check(ReviewSettingsStateSchema, value)) {
    return undefined;
  }
  const { customInstructions } = Value.Parse(ReviewSettingsStateSchema, value);

  return {
    customInstructions,
  };
}

export function setReviewWidget(
  ctx: ExtensionContext,
  options:
    | undefined
    | {
        targetLabel?: string;
        statusText?: string;
      },
): void {
  if (!ctx.hasUI) {
    return;
  }

  if (!options) {
    ctx.ui.setWidget(REVIEW_WIDGET_KEY, undefined);
    return;
  }

  const message = ["Review session active", options.targetLabel, options.statusText]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join(" · ");
  ctx.ui.setWidget(REVIEW_WIDGET_KEY, [message]);
}

export function isTerminalReviewStatus(
  status: string,
): status is "completed" | "failed" | "cancelled" {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function getReviewState(ctx: ExtensionContext): ReviewSessionState | undefined {
  let state: ReviewSessionState | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === REVIEW_STATE_TYPE) {
      state = readReviewSessionState(entry.data);
    }
  }

  return state;
}

export function isReviewStateActiveOnBranch(
  state: ReviewSessionState | undefined,
  branchEntries: Array<{ id?: string }>,
): state is ReviewSessionState {
  if (state?.active !== true) {
    return false;
  }

  if (state.branchAnchorId === undefined || state.branchAnchorId.length === 0) {
    return true;
  }

  return branchEntries.some(
    (entry) => typeof entry.id === "string" && entry.id === state.branchAnchorId,
  );
}

export function getReviewSettings(ctx: ExtensionContext): ReviewSettingsState {
  let state: ReviewSettingsState | undefined;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === REVIEW_SETTINGS_TYPE) {
      state = readReviewSettingsState(entry.data);
    }
  }

  return {
    customInstructions: state?.customInstructions?.trim() ?? undefined,
  };
}
