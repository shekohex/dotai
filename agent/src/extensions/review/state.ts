import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

import { REVIEW_SETTINGS_TYPE, REVIEW_STATE_TYPE, REVIEW_WIDGET_KEY } from "./constants.js";
import type { ReviewSessionState, ReviewSettingsState } from "./types.js";

function readReviewSessionState(value: unknown): ReviewSessionState | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const active: unknown = Reflect.get(value, "active");
  if (typeof active !== "boolean") {
    return undefined;
  }

  const branchAnchorId: unknown = Reflect.get(value, "branchAnchorId");
  if (branchAnchorId !== undefined && typeof branchAnchorId !== "string") {
    return undefined;
  }

  const subagentSessionId: unknown = Reflect.get(value, "subagentSessionId");
  const targetLabel: unknown = Reflect.get(value, "targetLabel");

  return {
    active,
    subagentSessionId: typeof subagentSessionId === "string" ? subagentSessionId : undefined,
    branchAnchorId: typeof branchAnchorId === "string" ? branchAnchorId : undefined,
    targetLabel: typeof targetLabel === "string" ? targetLabel : undefined,
    checkoutToRestore: undefined,
  };
}

function readReviewSettingsState(value: unknown): ReviewSettingsState | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const customInstructions: unknown = Reflect.get(value, "customInstructions");
  if (customInstructions !== undefined && typeof customInstructions !== "string") {
    return undefined;
  }

  return {
    customInstructions: typeof customInstructions === "string" ? customInstructions : undefined,
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
