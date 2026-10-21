import { useSyncExternalStore } from "react";

import { DEFAULT_COMPARE, type Compare } from "../shared/contracts.js";
import type { DiffSide } from "../shared/pierre-api.js";

export interface WorkspaceViewState {
  selectedPath: string | null;
  /** The file open in the File panel, and whether it opens in edit mode. */
  filePath: string | null;
  fileEdit: boolean;
  ignoreWhitespace: boolean;
  splitDiff: boolean;
  /** A review comment to scroll to in the Diffs panel; cleared once shown. */
  focus: { path: string; side: DiffSide; line: number } | null;
  /** The line a comment is being written on. */
  draft: { path: string; side: DiffSide; line: number } | null;
  /** Directories the user toggled away from the panel's default. */
  toggledDirs: Readonly<Record<string, true>>;
  /** Files whose diff is open in the Diffs panel. */
  expandedFiles: Readonly<Record<string, true>>;
  /** Bumped to ask the Diffs panel to scroll to `selectedPath`. */
  scrollNonce: number;
  hideDotfiles: boolean;
  showIgnored: boolean;
  compare: Compare;
}

const INITIAL: WorkspaceViewState = {
  selectedPath: null,
  filePath: null,
  fileEdit: false,
  ignoreWhitespace: false,
  splitDiff: false,
  draft: null,
  focus: null,
  toggledDirs: {},
  expandedFiles: {},
  scrollNonce: 0,
  hideDotfiles: false,
  showIgnored: false,
  compare: DEFAULT_COMPARE,
};

const states = new Map<string, WorkspaceViewState>();
const listeners = new Set<() => void>();

function read(workspaceId: string): WorkspaceViewState {
  return states.get(workspaceId) ?? INITIAL;
}

export function updateWorkspaceView(
  workspaceId: string,
  patch: (current: WorkspaceViewState) => Partial<WorkspaceViewState>,
): void {
  states.set(workspaceId, { ...read(workspaceId), ...patch(read(workspaceId)) });
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useWorkspaceView<T>(
  workspaceId: string,
  select: (state: WorkspaceViewState) => T,
): T {
  return useSyncExternalStore(
    subscribe,
    () => select(read(workspaceId)),
    () => select(read(workspaceId)),
  );
}

export function toggleDir(workspaceId: string, scope: string, dirPath: string): void {
  const key = `${scope}:${dirPath}`;
  updateWorkspaceView(workspaceId, ({ toggledDirs }) => {
    const next = { ...toggledDirs };
    if (next[key]) delete next[key];
    else next[key] = true;
    return { toggledDirs: next };
  });
}

export function setCompare(workspaceId: string, compare: Compare): void {
  updateWorkspaceView(workspaceId, () => ({ compare }));
}

export function collapseDirs(workspaceId: string, scope: string): void {
  updateWorkspaceView(workspaceId, ({ toggledDirs }) => ({
    toggledDirs: Object.fromEntries(
      Object.entries(toggledDirs).filter(([key]) => !key.startsWith(`${scope}:`)),
    ),
  }));
}

export function toggleFileExpanded(workspaceId: string, path: string): void {
  updateWorkspaceView(workspaceId, ({ expandedFiles }) => {
    const next = { ...expandedFiles };
    if (next[path]) delete next[path];
    else next[path] = true;
    return { expandedFiles: next };
  });
}

export function setExpandedFiles(workspaceId: string, paths: readonly string[]): void {
  updateWorkspaceView(workspaceId, () => ({
    expandedFiles: Object.fromEntries(paths.map((path) => [path, true as const])),
  }));
}

type OpenPanel = (
  id: string,
  options: { workspaceId: string; location?: "workspace" | "explorer" },
) => void;

let openPanelImpl: OpenPanel | null = null;

export function setPanelOpener(opener: OpenPanel | null): void {
  openPanelImpl = opener;
}

/** Opens a file in the File panel, in a workspace tab. */
export function showFile(workspaceId: string, path: string, edit = false): void {
  updateWorkspaceView(workspaceId, () => ({ filePath: path, fileEdit: edit }));
  openPanelImpl?.("file", { workspaceId, location: "workspace" });
}

/** Selects a file and shows it in the Diff panel, opening a workspace tab for it if needed. */
export function showDiff(workspaceId: string, path: string): void {
  updateWorkspaceView(workspaceId, (state) => ({
    selectedPath: path,
    expandedFiles: { ...state.expandedFiles, [path]: true },
    scrollNonce: state.scrollNonce + 1,
  }));
  openPanelImpl?.("diff", { workspaceId, location: "workspace" });
}

export function startDraft(workspaceId: string, path: string, side: DiffSide, line: number): void {
  updateWorkspaceView(workspaceId, () => ({ draft: { path, side, line } }));
}

export function cancelDraft(workspaceId: string): void {
  updateWorkspaceView(workspaceId, () => ({ draft: null }));
}

/** Opens one of Prism's panels from UI that has no plugin client at hand, such as a popover. */
export function openPrismPanel(workspaceId: string, id: "changes" | "files" | "diff", location: "workspace" | "explorer"): void {
  openPanelImpl?.(id, { workspaceId, location });
}

/** Opens the Diffs panel on the lines a review comment is attached to. */
export function goToComment(workspaceId: string, comment: { path: string; side: DiffSide; line: number }): void {
  showDiff(workspaceId, comment.path);
  updateWorkspaceView(workspaceId, () => ({
    focus: { path: comment.path, side: comment.side, line: comment.line },
  }));
}

export function clearFocus(workspaceId: string): void {
  updateWorkspaceView(workspaceId, () => ({ focus: null }));
}
