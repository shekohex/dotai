import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { matchesKey, Input, SelectList, type TUI } from "@mariozechner/pi-tui";

type SelectableFileEntry = {
  canonicalPath: string;
  isDirectory: boolean;
  isTracked: boolean;
};

type SelectorNavigation = {
  isSelectUp: (data: string) => boolean;
  isSelectDown: (data: string) => boolean;
  isSelectConfirm: (data: string) => boolean;
  isSelectCancel: (data: string) => boolean;
};

export function handleFileSelectorInput(
  data: string,
  runtime: {
    ctx: ExtensionContext;
    files: SelectableFileEntry[];
    gitRoot: string | null | undefined;
    quickAction: { value: "diff" | null };
    navigation: SelectorNavigation;
    done: (value: string | null) => void;
    tui: TUI;
  },
  selectList: SelectList | null,
  searchInput: Input,
  applyFilter: () => void,
): void {
  if (
    tryHandleFileSelectorDiffShortcut(
      data,
      selectList,
      runtime.files,
      runtime.gitRoot,
      runtime.ctx,
      runtime.done,
      runtime.quickAction,
    )
  ) {
    return;
  }

  if (
    tryHandleFileSelectorNavigation(data, selectList, runtime.navigation, runtime.done, runtime.tui)
  ) {
    return;
  }

  searchInput.handleInput(data);
  applyFilter();
  runtime.tui.requestRender();
}

function tryHandleFileSelectorDiffShortcut(
  data: string,
  selectList: SelectList | null,
  files: SelectableFileEntry[],
  gitRoot: string | null | undefined,
  ctx: ExtensionContext,
  done: (value: string | null) => void,
  quickAction: { value: "diff" | null },
): boolean {
  if (!matchesKey(data, "ctrl+alt+d")) {
    return false;
  }

  const selected = selectList?.getSelectedItem();
  if (selected === undefined || selected === null) {
    return true;
  }

  const file = files.find((entry) => entry.canonicalPath === selected.value);
  const canDiff =
    file !== undefined &&
    file.isTracked &&
    !file.isDirectory &&
    gitRoot !== undefined &&
    gitRoot !== null &&
    gitRoot.length > 0;
  if (!canDiff) {
    ctx.ui.notify("Diff is only available for tracked files", "warning");
    return true;
  }

  quickAction.value = "diff";
  done(selected.value);
  return true;
}

function tryHandleFileSelectorNavigation(
  data: string,
  selectList: SelectList | null,
  keybindings: SelectorNavigation,
  done: (value: string | null) => void,
  tui: TUI,
): boolean {
  const isNavigationKey =
    keybindings.isSelectUp(data) ||
    keybindings.isSelectDown(data) ||
    keybindings.isSelectConfirm(data) ||
    keybindings.isSelectCancel(data);
  if (!isNavigationKey) {
    return false;
  }

  if (selectList) {
    selectList.handleInput(data);
  } else if (keybindings.isSelectCancel(data)) {
    done(null);
  }
  tui.requestRender();
  return true;
}
