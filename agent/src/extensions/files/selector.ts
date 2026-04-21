import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import {
  Container,
  fuzzyFilter,
  Input,
  type Component,
  type SelectItem,
  SelectList,
  Spacer,
  Text,
  type TUI,
} from "@mariozechner/pi-tui";
import { hasRuntimePrimitive } from "../runtime-capabilities.js";
import { handleFileSelectorInput } from "./selector-input.js";

type SelectableFileEntry = {
  canonicalPath: string;
  displayPath: string;
  status?: string;
  isDirectory: boolean;
  isTracked: boolean;
};

export function showFileSelector(
  ctx: ExtensionContext,
  files: SelectableFileEntry[],
  selectedPath?: string | null,
  gitRoot?: string | null,
): Promise<{ selectedPath: string | null; quickAction: "diff" | null }> {
  const items = buildFileSelectorItems(files);
  const quickAction = { value: null as "diff" | null };
  const selection = showFileSelectorDialog(ctx, files, items, quickAction, selectedPath, gitRoot);
  return selection.then((selected) => ({
    selectedPath: selected,
    quickAction: quickAction.value,
  }));
}

function buildFileSelectorItems(files: SelectableFileEntry[]): SelectItem[] {
  return files.map((file) => {
    const directoryLabel = file.isDirectory ? " [directory]" : "";
    const statusSuffix =
      file.status !== undefined && file.status.length > 0 ? ` [${file.status}]` : "";
    return {
      value: file.canonicalPath,
      label: `${file.displayPath}${directoryLabel}${statusSuffix}`,
    };
  });
}

function showFileSelectorDialog(
  ctx: ExtensionContext,
  files: SelectableFileEntry[],
  items: SelectItem[],
  quickAction: { value: "diff" | null },
  selectedPath?: string | null,
  gitRoot?: string | null,
): Promise<string | null> {
  if (!hasRuntimePrimitive(ctx, "custom")) {
    return showFileSelectorFallback(files, selectedPath, ctx);
  }

  return ctx.ui.custom<string | null>((tui, theme, keybindings, done) =>
    createFileSelectorComponent(ctx, files, items, quickAction, selectedPath, gitRoot, {
      tui,
      theme,
      isSelectUp: (data) => keybindings.matches(data, "tui.select.up"),
      isSelectDown: (data) => keybindings.matches(data, "tui.select.down"),
      isSelectConfirm: (data) => keybindings.matches(data, "tui.select.confirm"),
      isSelectCancel: (data) => keybindings.matches(data, "tui.select.cancel"),
      done,
    }),
  );
}

async function showFileSelectorFallback(
  files: SelectableFileEntry[],
  selectedPath: string | null | undefined,
  ctx: ExtensionContext,
): Promise<string | null> {
  const hasSelectedPath =
    selectedPath !== undefined && selectedPath !== null && selectedPath.length > 0;
  const orderedFiles = hasSelectedPath
    ? [
        ...files.filter((file) => file.canonicalPath === selectedPath),
        ...files.filter((file) => file.canonicalPath !== selectedPath),
      ]
    : files;

  const options = orderedFiles.map((file, index) => {
    const directoryLabel = file.isDirectory ? " [directory]" : "";
    const statusSuffix =
      file.status !== undefined && file.status.length > 0 ? ` [${file.status}]` : "";
    return `${index + 1}. ${file.displayPath}${directoryLabel}${statusSuffix}`;
  });

  const selected = await ctx.ui.select("Select file", options);
  if (selected === undefined || selected.length === 0) {
    return null;
  }

  const selectedIndex = options.findIndex((option) => option === selected);
  if (selectedIndex < 0) {
    return null;
  }
  return orderedFiles[selectedIndex]?.canonicalPath ?? null;
}

type FileSelectorRuntime = {
  tui: TUI;
  theme: Theme;
  isSelectUp: (data: string) => boolean;
  isSelectDown: (data: string) => boolean;
  isSelectConfirm: (data: string) => boolean;
  isSelectCancel: (data: string) => boolean;
  done: (value: string | null) => void;
};

function createFileSelectorComponent(
  ctx: ExtensionContext,
  files: SelectableFileEntry[],
  items: SelectItem[],
  quickAction: { value: "diff" | null },
  selectedPath: string | null | undefined,
  gitRoot: string | null | undefined,
  runtime: FileSelectorRuntime,
): Component {
  const view = createFileSelectorView(runtime.theme);
  const navigation = {
    isSelectUp: runtime.isSelectUp,
    isSelectDown: runtime.isSelectDown,
    isSelectConfirm: runtime.isSelectConfirm,
    isSelectCancel: runtime.isSelectCancel,
  };
  const filterState = createFileSelectorFilterState({
    view,
    theme: runtime.theme,
    items,
    selectedPath,
    done: runtime.done,
  });

  return {
    render(width: number) {
      return view.container.render(width);
    },
    invalidate() {
      view.container.invalidate();
    },
    handleInput(data: string) {
      handleFileSelectorInput(
        data,
        {
          ctx,
          files,
          gitRoot,
          quickAction,
          navigation,
          done: runtime.done,
          tui: runtime.tui,
        },
        filterState.getSelectList(),
        view.searchInput,
        filterState.applyFilter,
      );
    },
  };
}

function createFileSelectorFilterState(input: {
  view: { searchInput: Input; listContainer: Container };
  theme: Theme;
  items: SelectItem[];
  selectedPath: string | null | undefined;
  done: (value: string | null) => void;
}): { applyFilter: () => void; getSelectList: () => SelectList | null } {
  let filteredItems = input.items;
  let selectList: SelectList | null = null;
  const updateList = () => {
    selectList = renderFileSelectorList(
      input.view.listContainer,
      input.theme,
      filteredItems,
      input.selectedPath,
      input.done,
    );
  };
  const applyFilter = () => {
    const query = input.view.searchInput.getValue();
    filteredItems = query
      ? fuzzyFilter(
          input.items,
          query,
          (item) => `${item.label} ${item.value} ${item.description ?? ""}`,
        )
      : input.items;
    updateList();
  };
  applyFilter();
  return { applyFilter, getSelectList: () => selectList };
}

function createFileSelectorView(theme: Theme): {
  container: Container;
  searchInput: Input;
  listContainer: Container;
} {
  const container = new Container();
  container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
  container.addChild(new Text(theme.fg("accent", theme.bold(" Select file")), 0, 0));
  const searchInput = new Input();
  container.addChild(searchInput);
  container.addChild(new Spacer(1));
  const listContainer = new Container();
  container.addChild(listContainer);
  container.addChild(
    new Text(
      theme.fg("dim", "Type to filter • enter to select • ctrl+alt+d diff • esc to cancel"),
      0,
      0,
    ),
  );
  container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
  return { container, searchInput, listContainer };
}

function renderFileSelectorList(
  listContainer: Container,
  theme: Theme,
  filteredItems: SelectItem[],
  selectedPath: string | null | undefined,
  done: (value: string | null) => void,
): SelectList | null {
  listContainer.clear();
  if (filteredItems.length === 0) {
    listContainer.addChild(new Text(theme.fg("warning", "  No matching files"), 0, 0));
    return null;
  }

  const selectList = new SelectList(filteredItems, Math.min(filteredItems.length, 12), {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("dim", text),
    noMatch: (text) => theme.fg("warning", text),
  });
  if (selectedPath !== undefined && selectedPath !== null && selectedPath.length > 0) {
    const index = filteredItems.findIndex((item) => item.value === selectedPath);
    if (index >= 0) {
      selectList.setSelectedIndex(index);
    }
  }
  selectList.onSelect = (item) => {
    done(item.value);
  };
  selectList.onCancel = () => {
    done(null);
  };
  listContainer.addChild(selectList);
  return selectList;
}
