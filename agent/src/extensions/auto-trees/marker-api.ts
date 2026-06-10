import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { asRecord } from "../../utils/unknown-data.js";

export type MarkerState = {
  version: 1;
  markerId: string;
};

export type MarkerApiOptions = {
  stateEntryType: string;
  markerLabel: string;
};

export type MarkerApi = {
  readState(ctx: ExtensionContext): MarkerState | undefined;
  getSemanticLeafId(ctx: ExtensionContext): string | undefined;
  applyMarker(
    ctx: ExtensionContext,
    nextMarkerId: string,
    notifyMessage?: string,
    options?: { previousMarkerId?: string },
  ): MarkerState;
  markCurrent(ctx: ExtensionContext, notifyMessage?: string): MarkerState | undefined;
};

function isMarkerState(value: unknown): value is MarkerState {
  const candidate = asRecord(value);
  if (candidate === undefined) return false;
  return candidate.version === 1 && typeof candidate.markerId === "string";
}

export function readMarkerStateFromBranch(
  ctx: ExtensionContext,
  stateEntryType: string,
): MarkerState | undefined {
  let state: MarkerState | undefined;

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== stateEntryType) continue;
    if (isMarkerState(entry.data)) {
      state = entry.data;
    }
  }

  return state;
}

export function getSemanticLeafId(ctx: ExtensionContext): string | undefined {
  let currentId: string | null | undefined = ctx.sessionManager.getLeafId();

  while (currentId !== undefined && currentId !== null && currentId.length > 0) {
    const entry = ctx.sessionManager.getEntry(currentId);
    if (!entry) return undefined;

    if (entry.type === "custom" || entry.type === "label") {
      currentId = entry.parentId;
      continue;
    }

    return currentId;
  }

  return undefined;
}

export function createMarkerApi(pi: ExtensionAPI, options: MarkerApiOptions): MarkerApi {
  let markerId: string | undefined;

  const readState = (ctx: ExtensionContext): MarkerState | undefined => {
    markerId = readMarkerStateFromBranch(ctx, options.stateEntryType)?.markerId;
    return markerId !== undefined && markerId.length > 0 ? { version: 1, markerId } : undefined;
  };

  const applyMarker = (
    ctx: ExtensionContext,
    nextMarkerId: string,
    notifyMessage?: string,
    markerOptions?: { previousMarkerId?: string },
  ): MarkerState => {
    const previousMarkerId =
      markerOptions?.previousMarkerId ??
      markerId ??
      readMarkerStateFromBranch(ctx, options.stateEntryType)?.markerId;

    if (
      previousMarkerId !== undefined &&
      previousMarkerId.length > 0 &&
      previousMarkerId !== nextMarkerId &&
      ctx.sessionManager.getLabel(previousMarkerId) === options.markerLabel
    ) {
      pi.setLabel(previousMarkerId, undefined);
    }

    let labelNote = "";
    const existingLabel = ctx.sessionManager.getLabel(nextMarkerId);
    if (existingLabel === undefined || existingLabel === options.markerLabel) {
      pi.setLabel(nextMarkerId, options.markerLabel);
    } else {
      labelNote = ` Existing label "${existingLabel}" kept.`;
    }

    const state = { version: 1, markerId: nextMarkerId } satisfies MarkerState;
    pi.appendEntry(options.stateEntryType, state);
    markerId = nextMarkerId;

    if (notifyMessage !== undefined && notifyMessage.length > 0) {
      ctx.ui.notify(`${notifyMessage}${labelNote}`, "info");
    }

    return state;
  };

  return {
    readState,
    getSemanticLeafId,
    applyMarker,
    markCurrent(ctx, notifyMessage) {
      const targetId = getSemanticLeafId(ctx);
      let markerState: MarkerState | undefined;
      if (targetId !== undefined && targetId.length > 0) {
        markerState = applyMarker(ctx, targetId, notifyMessage);
      }
      return markerState;
    },
  };
}
