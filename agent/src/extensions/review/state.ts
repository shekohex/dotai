import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

import { REVIEW_SETTINGS_TYPE, REVIEW_STATE_TYPE, REVIEW_WIDGET_KEY } from "./constants.js";
import type { ReviewSessionState, ReviewSettingsState } from "./types.js";

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
    .filter((value): value is string => Boolean(value))
    .join(" · ");
  ctx.ui.setWidget(REVIEW_WIDGET_KEY, (_tui, theme) => {
    const text = new Text(theme.fg("warning", message), 0, 0);
    return {
      render(width: number) {
        return text.render(width);
      },
      invalidate() {
        text.invalidate();
      },
    };
  });
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
      state = entry.data as ReviewSessionState | undefined;
    }
  }

  return state;
}

export function isReviewStateActiveOnBranch(
  state: ReviewSessionState | undefined,
  branchEntries: Array<{ id?: string }>,
): state is ReviewSessionState {
  if (!state?.active) {
    return false;
  }

  if (!state.branchAnchorId) {
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
      state = entry.data as ReviewSettingsState | undefined;
    }
  }

  return {
    customInstructions: state?.customInstructions?.trim() || undefined,
  };
}
