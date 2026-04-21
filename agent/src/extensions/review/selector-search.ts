import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import {
  Container,
  fuzzyFilter,
  Input,
  type SelectItem,
  SelectList,
  Spacer,
  Text,
} from "@mariozechner/pi-tui";
import { hasRuntimePrimitive } from "../runtime-capabilities.js";
import { hasUncommittedChanges, getCurrentBranch, getDefaultBranch } from "./deps.js";

type SearchableSelectNavigation = {
  isSelectUp: (data: string) => boolean;
  isSelectDown: (data: string) => boolean;
  isSelectConfirm: (data: string) => boolean;
  isSelectCancel: (data: string) => boolean;
  done: (value: string | null) => void;
};

export async function getSmartDefault(
  pi: ExtensionAPI,
): Promise<"uncommitted" | "baseBranch" | "commit"> {
  if (await hasUncommittedChanges(pi)) {
    return "uncommitted";
  }

  const currentBranch = await getCurrentBranch(pi);
  const defaultBranch = await getDefaultBranch(pi);
  if (
    typeof currentBranch === "string" &&
    currentBranch.length > 0 &&
    currentBranch !== defaultBranch
  ) {
    return "baseBranch";
  }

  return "commit";
}

function handleSearchableSelectNavigation(
  data: string,
  selectList: SelectList | null,
  navigation: SearchableSelectNavigation,
  tui: { requestRender: () => void },
): boolean {
  const isNavigationKey =
    navigation.isSelectUp(data) ||
    navigation.isSelectDown(data) ||
    navigation.isSelectConfirm(data) ||
    navigation.isSelectCancel(data);
  if (!isNavigationKey) {
    return false;
  }

  if (selectList) {
    selectList.handleInput(data);
  } else if (navigation.isSelectCancel(data)) {
    navigation.done(null);
  }
  tui.requestRender();
  return true;
}

export function showSearchableSelect(
  ctx: ExtensionContext,
  input: {
    title: string;
    emptyMessage: string;
    items: SelectItem[];
  },
): Promise<string | null> {
  if (!hasRuntimePrimitive(ctx, "custom")) {
    return showSelectFallback(ctx, input);
  }

  return ctx.ui.custom<string | null>((tui, theme, keybindings, done) =>
    createSearchableSelectComponent(input, {
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

async function showSelectFallback(
  ctx: ExtensionContext,
  input: {
    title: string;
    items: SelectItem[];
  },
): Promise<string | null> {
  const options = input.items.map((item) => item.label);
  const selectedLabel = await ctx.ui.select(input.title, options);
  if (selectedLabel === undefined || selectedLabel.length === 0) {
    return null;
  }

  const selectedItem = input.items.find((item) => item.label === selectedLabel);
  return selectedItem?.value ?? null;
}

function createSearchableSelectComponent(
  input: { title: string; emptyMessage: string; items: SelectItem[] },
  viewRuntime: {
    tui: { requestRender: () => void };
    theme: Theme;
    isSelectUp: (data: string) => boolean;
    isSelectDown: (data: string) => boolean;
    isSelectConfirm: (data: string) => boolean;
    isSelectCancel: (data: string) => boolean;
    done: (value: string | null) => void;
  },
) {
  const view = createSearchableSelectView(viewRuntime.theme, input.title);
  let filteredItems = input.items;
  let selectList: SelectList | null = null;

  const updateList = () => {
    selectList = renderSearchableSelectList(
      view.listContainer,
      viewRuntime.theme,
      filteredItems,
      input.emptyMessage,
      viewRuntime.done,
    );
  };

  const applyFilter = () => {
    const query = view.searchInput.getValue();
    filteredItems = filterSelectItems(input.items, query);
    updateList();
  };

  applyFilter();

  return {
    render: (width: number) => view.container.render(width),
    invalidate: () => {
      view.container.invalidate();
    },
    handleInput(data: string) {
      if (handleSearchableSelectNavigation(data, selectList, viewRuntime, viewRuntime.tui)) {
        return;
      }
      view.searchInput.handleInput(data);
      applyFilter();
      viewRuntime.tui.requestRender();
    },
  };
}

function filterSelectItems(items: SelectItem[], query: string): SelectItem[] {
  if (!query) {
    return items;
  }
  return fuzzyFilter(
    items,
    query,
    (item) => `${item.label} ${item.value} ${item.description ?? ""}`,
  );
}

function createSearchableSelectView(
  theme: Theme,
  title: string,
): {
  container: Container;
  searchInput: Input;
  listContainer: Container;
} {
  const container = new Container();
  container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
  container.addChild(new Text(theme.fg("accent", theme.bold(title))));
  const searchInput = new Input();
  container.addChild(searchInput);
  container.addChild(new Spacer(1));
  const listContainer = new Container();
  container.addChild(listContainer);
  container.addChild(new Text(theme.fg("dim", "Type to filter • enter to select • esc to cancel")));
  container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
  return { container, searchInput, listContainer };
}

function renderSearchableSelectList(
  listContainer: Container,
  theme: Theme,
  filteredItems: SelectItem[],
  emptyMessage: string,
  done: (value: string | null) => void,
): SelectList | null {
  listContainer.clear();
  if (filteredItems.length === 0) {
    listContainer.addChild(new Text(theme.fg("warning", emptyMessage)));
    return null;
  }

  const selectList = new SelectList(filteredItems, Math.min(filteredItems.length, 10), {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("dim", text),
    noMatch: (text) => theme.fg("warning", text),
  });
  selectList.onSelect = (item) => {
    done(item.value);
  };
  selectList.onCancel = () => {
    done(null);
  };
  listContainer.addChild(selectList);
  return selectList;
}
