import type { KeybindingsManager, Theme } from "@mariozechner/pi-coding-agent";
import {
  Container,
  Input,
  Key,
  SelectList,
  Spacer,
  Text,
  fuzzyFilter,
  matchesKey,
  type Component,
  type Focusable,
  type SelectListTheme,
  type TUI,
} from "@mariozechner/pi-tui";
import {
  countLines,
  createSelectItem,
  createSelectListTheme,
  formatPreview,
  formatPreviewLines,
  formatRelativeAge,
} from "./browser-helpers.js";
import {
  formatPreviewMeta,
  getEmptyListMessage,
  getPreviewHint,
  initializePromptStashBrowserRoot,
} from "./browser-layout.js";

type PromptStashEntry = {
  id: string;
  text: string;
  createdAt: number;
};

export type PromptStashBrowserAction =
  | { type: "open"; entry: PromptStashEntry }
  | { type: "pop"; entry: PromptStashEntry }
  | { type: "delete"; entry: PromptStashEntry }
  | null;

export class PromptStashBrowser implements Component, Focusable {
  private readonly root = new Container();
  private readonly listContainer = new Container();
  private readonly previewContainer = new Container();
  private readonly searchInput = new Input();
  private readonly selectListTheme: SelectListTheme;
  private readonly theme: Theme;
  private selectList: SelectList | null = null;
  private filteredEntries: PromptStashEntry[] = [];
  private selectedIndex = 0;
  private closed = false;
  private _focused = false;

  constructor(
    private readonly tui: TUI,
    theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly entries: PromptStashEntry[],
    private readonly done: (result: PromptStashBrowserAction) => void,
  ) {
    this.theme = theme;
    this.selectListTheme = createSelectListTheme(theme);
    initializePromptStashBrowserRoot({
      root: this.root,
      theme,
      searchInput: this.searchInput,
      listContainer: this.listContainer,
      previewContainer: this.previewContainer,
    });

    this.filteredEntries = [...entries];
    this.rebuildList();
    this.refreshPreview();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  handleInput(data: string): void {
    if (this.closed) {
      return;
    }
    if (this.handleNavigationInput(data) || this.handleEntryActionInput(data)) {
      return;
    }
    const before = this.searchInput.getValue();
    this.searchInput.handleInput(data);
    if (before !== this.searchInput.getValue()) {
      this.applyFilter();
      return;
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    return this.root.render(width);
  }

  invalidate(): void {
    this.root.invalidate();
  }

  private handleNavigationInput(data: string): boolean {
    if (
      this.keybindings.matches(data, "tui.select.cancel") ||
      this.keybindings.matches(data, "app.interrupt")
    ) {
      this.close(null);
      return true;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
      return true;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      this.moveSelection(1);
      return true;
    }
    const pageDelta = this.getPageSelectionDelta(data);
    if (pageDelta !== undefined) {
      this.moveSelection(pageDelta);
      return true;
    }
    if (matchesKey(data, "home")) {
      this.setSelectionIndex(0);
      return true;
    }
    if (matchesKey(data, "end")) {
      this.setSelectionIndex(this.filteredEntries.length - 1);
      return true;
    }
    return false;
  }

  private getPageSelectionDelta(data: string): number | undefined {
    const halfPage = Math.max(1, Math.floor(this.visibleCount() / 2));
    if (this.keybindings.matches(data, "tui.select.pageUp")) {
      return -halfPage;
    }
    if (this.keybindings.matches(data, "tui.select.pageDown")) {
      return halfPage;
    }
    return undefined;
  }

  private handleEntryActionInput(data: string): boolean {
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      return this.closeSelectedEntry("open");
    }
    if (matchesKey(data, Key.ctrlAlt("o"))) {
      return this.closeSelectedEntry("pop");
    }
    if (matchesKey(data, Key.ctrl("backspace"))) {
      return this.closeSelectedEntry("delete");
    }
    return false;
  }

  private closeSelectedEntry(action: "open" | "pop" | "delete"): boolean {
    const entry = this.getSelectedEntry();
    if (!entry) {
      return false;
    }
    this.close({ type: action, entry });
    return true;
  }

  private close(result: PromptStashBrowserAction): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.done(result);
  }

  private visibleCount(): number {
    return Math.min(this.filteredEntries.length, 10);
  }

  private getSelectedEntry(): PromptStashEntry | null {
    return this.filteredEntries[this.selectedIndex] ?? null;
  }

  private moveSelection(delta: number): void {
    if (this.filteredEntries.length === 0) {
      return;
    }
    const next = this.selectedIndex + delta;
    this.selectedIndex =
      ((next % this.filteredEntries.length) + this.filteredEntries.length) %
      this.filteredEntries.length;
    this.selectList?.setSelectedIndex(this.selectedIndex);
    this.refreshPreview();
    this.invalidate();
    this.tui.requestRender();
  }

  private setSelectionIndex(index: number): void {
    if (this.filteredEntries.length === 0) {
      return;
    }
    this.selectedIndex = Math.max(0, Math.min(index, this.filteredEntries.length - 1));
    this.selectList?.setSelectedIndex(this.selectedIndex);
    this.refreshPreview();
    this.invalidate();
    this.tui.requestRender();
  }

  private applyFilter(): void {
    const previousSelected = this.getSelectedEntry();
    const query = this.searchInput.getValue().trim();
    this.filteredEntries = query
      ? fuzzyFilter(
          this.entries,
          query,
          (entry) =>
            `${formatPreview(entry.text)} ${entry.text} ${countLines(entry.text)} ${formatRelativeAge(entry.createdAt)}`,
        )
      : [...this.entries];
    this.selectedIndex = 0;
    if (previousSelected) {
      const index = this.filteredEntries.findIndex((entry) => entry.id === previousSelected.id);
      if (index >= 0) {
        this.selectedIndex = index;
      }
    }
    this.rebuildList();
    this.refreshPreview();
    this.invalidate();
    this.tui.requestRender();
  }

  private rebuildList(): void {
    this.listContainer.clear();
    this.selectList = null;
    if (this.filteredEntries.length === 0) {
      this.listContainer.addChild(
        new Text(this.theme.fg("dim", getEmptyListMessage(this.entries.length)), 0, 0),
      );
      return;
    }
    const items = this.filteredEntries.map((entry) => createSelectItem(entry));
    this.selectList = new SelectList(items, this.visibleCount(), this.selectListTheme, {
      minPrimaryColumnWidth: 24,
      maxPrimaryColumnWidth: 48,
    });
    this.selectList.setSelectedIndex(this.selectedIndex);
    this.listContainer.addChild(this.selectList);
  }

  private refreshPreview(): void {
    this.previewContainer.clear();
    const entry = this.getSelectedEntry();
    if (!entry) {
      this.previewContainer.addChild(
        new Text(this.theme.fg("dim", getPreviewHint(this.entries.length)), 0, 0),
      );
      return;
    }
    this.previewContainer.addChild(new Text(this.theme.fg("accent", "Preview"), 0, 0));
    this.previewContainer.addChild(
      new Text(this.theme.fg("muted", formatPreviewMeta(entry, 120)), 0, 0),
    );
    this.previewContainer.addChild(new Spacer(1));
    for (const line of formatPreviewLines(entry, 120)) {
      this.previewContainer.addChild(new Text(line, 0, 0));
    }
  }
}
