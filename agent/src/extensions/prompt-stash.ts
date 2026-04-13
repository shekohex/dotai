import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ExtensionAPI, ExtensionContext, KeybindingsManager, Theme } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, getAgentDir } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  Container,
  Input,
  Key,
  matchesKey,
  SelectList,
  Text,
  truncateToWidth,
  fuzzyFilter,
  Spacer,
  type Component,
  type Focusable,
  type SelectItem,
  type SelectListTheme,
  type TUI,
} from "@mariozechner/pi-tui";

const STASH_VERSION = 1;
const MAX_STASH_ENTRIES = 50;
const STASH_FILE_NAME = "prompt-stash.jsonl";

const PromptStashEntrySchema = Type.Object(
  {
    version: Type.Literal(STASH_VERSION),
    id: Type.String(),
    text: Type.String(),
    createdAt: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

type PromptStashEntry = Static<typeof PromptStashEntrySchema>;

type PromptStashBrowserAction =
  | { type: "open"; entry: PromptStashEntry }
  | { type: "pop"; entry: PromptStashEntry }
  | { type: "delete"; entry: PromptStashEntry }
  | null;

export type { PromptStashEntry };

function expandUserPath(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function getResolvedAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ? expandUserPath(process.env.PI_CODING_AGENT_DIR) : getAgentDir();
}

export function getStashFilePath(): string {
  return path.join(getResolvedAgentDir(), STASH_FILE_NAME);
}

async function readStashEntries(cwd: string): Promise<{ entries: PromptStashEntry[]; dirty: boolean }> {
  const stashFilePath = getStashFilePath();

  try {
    const raw = await readFile(stashFilePath, "utf8");
    if (!raw) {
      return { entries: [], dirty: false };
    }

    const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = normalized.split("\n");
    const dirty = normalized.endsWith("\n");
    if (dirty) {
      lines.pop();
    }

    const entries: PromptStashEntry[] = [];
    let needsRewrite = dirty;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        needsRewrite = true;
        continue;
      }

      if (trimmed !== line) {
        needsRewrite = true;
      }

      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!Value.Check(PromptStashEntrySchema, parsed)) {
          needsRewrite = true;
          continue;
        }
        entries.push(Value.Parse(PromptStashEntrySchema, parsed));
      } catch {
        needsRewrite = true;
      }
    }

    const normalizedEntries = entries.slice(0, MAX_STASH_ENTRIES);
    if (normalizedEntries.length !== entries.length) {
      needsRewrite = true;
    }

    return { entries: normalizedEntries, dirty: needsRewrite };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return { entries: [], dirty: false };
    }
    throw error;
  }
}

async function writeStashEntries(cwd: string, entries: PromptStashEntry[]): Promise<void> {
  const stashFilePath = getStashFilePath();
  await mkdir(path.dirname(stashFilePath), { recursive: true });
  const content = entries.slice(0, MAX_STASH_ENTRIES).map((entry) => JSON.stringify(entry)).join("\n");
  await writeFile(stashFilePath, content, "utf8");
}

export async function loadStashEntries(cwd: string): Promise<PromptStashEntry[]> {
  const { entries, dirty } = await readStashEntries(cwd);
  if (dirty) {
    await writeStashEntries(cwd, entries);
  }
  return entries;
}

export async function saveStashEntries(cwd: string, entries: PromptStashEntry[]): Promise<void> {
  await writeStashEntries(cwd, entries.slice(0, MAX_STASH_ENTRIES));
}

function createStashEntry(text: string): PromptStashEntry {
  return {
    version: STASH_VERSION,
    id: randomUUID(),
    text,
    createdAt: Date.now(),
  };
}

function countLines(text: string): number {
  return text.split(/\r\n|\r|\n/).length;
}

function formatRelativeAge(createdAt: number): string {
  const delta = Math.max(0, Date.now() - createdAt);

  if (delta < 30_000) {
    return "just now";
  }

  if (delta < 60_000) {
    return `${Math.floor(delta / 1_000)}s ago`;
  }

  if (delta < 3_600_000) {
    return `${Math.floor(delta / 60_000)}m ago`;
  }

  if (delta < 86_400_000) {
    return `${Math.floor(delta / 3_600_000)}h ago`;
  }

  return `${Math.floor(delta / 86_400_000)}d ago`;
}

function formatPreview(text: string): string {
  const firstLine = text
    .split(/\r\n|\r|\n/)
    .find((line) => line.trim().length > 0)
    ?.trim();

  if (!firstLine) {
    return "(blank)";
  }

  return firstLine.replace(/\s+/g, " ");
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function createSelectItem(entry: PromptStashEntry): SelectItem {
  return {
    value: entry.id,
    label: formatPreview(entry.text),
    description: `${countLines(entry.text)} lines • ${formatRelativeAge(entry.createdAt)}`,
  };
}

function createSelectListTheme(theme: Theme): SelectListTheme {
  return {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("dim", text),
    noMatch: (text) => theme.fg("warning", text),
  };
}

function formatPreviewLines(entry: PromptStashEntry, width: number): string[] {
  const lines = entry.text.split(/\r\n|\r|\n/).slice(0, 4);
  const previewLines = lines.map((line) => truncateToWidth(line, Math.max(0, width), ""));
  const remaining = countLines(entry.text) - lines.length;

  if (remaining > 0) {
    previewLines.push(truncateToWidth(`… ${remaining} more`, Math.max(0, width), ""));
  }

  return previewLines;
}

class PromptStashBrowser implements Component, Focusable {
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

    this.root.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
    this.root.addChild(new Text(theme.fg("accent", theme.bold(" Prompt Stash ")), 0, 0));
    this.root.addChild(new Spacer(1));
    this.root.addChild(
      new Text(
        theme.fg("dim", "Search to filter • enter open • ctrl+shift+o pop • ctrl+backspace delete • esc cancel"),
        0,
        0,
      ),
    );
    this.root.addChild(new Spacer(1));
    this.root.addChild(new Text(theme.fg("muted", "Search"), 0, 0));
    this.root.addChild(this.searchInput);
    this.root.addChild(new Spacer(1));
    this.root.addChild(this.listContainer);
    this.root.addChild(new Spacer(1));
    this.root.addChild(this.previewContainer);
    this.root.addChild(new Spacer(1));
    this.root.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

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

    if (this.keybindings.matches(data, "tui.select.cancel") || this.keybindings.matches(data, "app.interrupt")) {
      this.close(null);
      return;
    }

    if (this.keybindings.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
      return;
    }

    if (this.keybindings.matches(data, "tui.select.down")) {
      this.moveSelection(1);
      return;
    }

    if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.moveSelection(-Math.max(1, Math.floor(this.visibleCount() / 2)));
      return;
    }

    if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.moveSelection(Math.max(1, Math.floor(this.visibleCount() / 2)));
      return;
    }

    if (matchesKey(data, "home")) {
      this.setSelectionIndex(0);
      return;
    }

    if (matchesKey(data, "end")) {
      this.setSelectionIndex(this.filteredEntries.length - 1);
      return;
    }

    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const entry = this.getSelectedEntry();
      if (entry) {
        this.close({ type: "open", entry });
      }
      return;
    }

    if (matchesKey(data, "ctrl+shift+o")) {
      const entry = this.getSelectedEntry();
      if (entry) {
        this.close({ type: "pop", entry });
      }
      return;
    }

    if (matchesKey(data, "ctrl+backspace")) {
      const entry = this.getSelectedEntry();
      if (entry) {
        this.close({ type: "delete", entry });
      }
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
    const wrapped = ((next % this.filteredEntries.length) + this.filteredEntries.length) % this.filteredEntries.length;
    this.selectedIndex = wrapped;
    if (this.selectList) {
      this.selectList.setSelectedIndex(this.selectedIndex);
    }
    this.refreshPreview();
    this.invalidate();
    this.tui.requestRender();
  }

  private setSelectionIndex(index: number): void {
    if (this.filteredEntries.length === 0) {
      return;
    }

    this.selectedIndex = Math.max(0, Math.min(index, this.filteredEntries.length - 1));
    if (this.selectList) {
      this.selectList.setSelectedIndex(this.selectedIndex);
    }
    this.refreshPreview();
    this.invalidate();
    this.tui.requestRender();
  }

  private applyFilter(): void {
    const previousSelected = this.getSelectedEntry();
    const query = this.searchInput.getValue().trim();

    this.filteredEntries = query
      ? fuzzyFilter(this.entries, query, (entry) => `${formatPreview(entry.text)} ${entry.text} ${countLines(entry.text)} ${formatRelativeAge(entry.createdAt)}`)
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
      const message = this.entries.length === 0
        ? "No stashed prompts yet"
        : "No matching stash entries";
      this.listContainer.addChild(new Text(this.theme.fg("dim", message), 0, 0));
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
      const hint = this.entries.length === 0
        ? "Press ctrl+alt+s to stash the current prompt"
        : "Choose a stash entry to preview it here";
      this.previewContainer.addChild(new Text(this.theme.fg("dim", hint), 0, 0));
      return;
    }

    this.previewContainer.addChild(new Text(this.theme.fg("accent", "Preview"), 0, 0));
    this.previewContainer.addChild(
      new Text(
        this.theme.fg(
          "muted",
          ` ${countLines(entry.text)} lines • ${formatRelativeAge(entry.createdAt)} • ${truncateToWidth(formatPreview(entry.text), 120, "")}`,
        ),
        0,
        0,
      ),
    );
    this.previewContainer.addChild(new Spacer(1));

    for (const line of formatPreviewLines(entry, 120)) {
      this.previewContainer.addChild(new Text(line, 0, 0));
    }
  }
}

async function stashCurrentDraft(ctx: ExtensionContext): Promise<void> {
  const current = ctx.ui.getEditorText();
  if (current.trim().length === 0) {
    ctx.ui.notify("Nothing to stash", "info");
    return;
  }

  const entries = await loadStashEntries(ctx.cwd);
  const nextEntries = [createStashEntry(current), ...entries].slice(0, MAX_STASH_ENTRIES);
  await saveStashEntries(ctx.cwd, nextEntries);
  ctx.ui.setEditorText("");

  const pruned = Math.max(0, entries.length + 1 - MAX_STASH_ENTRIES);
  const suffix = pruned > 0 ? ` • pruned ${pruned} old ${pruned === 1 ? "entry" : "entries"}` : "";
  ctx.ui.notify(`Prompt stashed (${countLines(current)} lines)${suffix}`, "info");
}

async function popLatestEntry(ctx: ExtensionContext): Promise<void> {
  const entries = await loadStashEntries(ctx.cwd);
  const entry = entries[0];

  if (!entry) {
    ctx.ui.notify("No stashed prompts yet", "info");
    return;
  }

  await saveStashEntries(ctx.cwd, entries.slice(1));
  ctx.ui.setEditorText(entry.text);
  ctx.ui.notify(`Applied latest stash entry (${countLines(entry.text)} lines)`, "info");
}

async function deleteStashEntry(ctx: ExtensionContext, entryId: string): Promise<boolean> {
  const entries = await loadStashEntries(ctx.cwd);
  const nextEntries = entries.filter((entry) => entry.id !== entryId);

  if (nextEntries.length === entries.length) {
    return false;
  }

  await saveStashEntries(ctx.cwd, nextEntries);
  return true;
}

async function applyStashSelection(ctx: ExtensionContext, action: PromptStashBrowserAction): Promise<void> {
  if (!action) {
    return;
  }

  switch (action.type) {
    case "open": {
      ctx.ui.setEditorText(action.entry.text);
      ctx.ui.notify(`Opened stash entry (${countLines(action.entry.text)} lines)`, "info");
      return;
    }

    case "pop": {
      const removed = await deleteStashEntry(ctx, action.entry.id);
      if (!removed) {
        ctx.ui.notify("Selected stash entry no longer exists", "warning");
        return;
      }

      ctx.ui.setEditorText(action.entry.text);
      ctx.ui.notify(`Popped stash entry (${countLines(action.entry.text)} lines)`, "info");
      return;
    }

    case "delete": {
      const removed = await deleteStashEntry(ctx, action.entry.id);
      if (!removed) {
        ctx.ui.notify("Selected stash entry no longer exists", "warning");
        return;
      }

      ctx.ui.notify("Deleted stash entry", "info");
      return;
    }
  }
}

async function showStashBrowser(ctx: ExtensionContext): Promise<PromptStashBrowserAction> {
  const entries = await loadStashEntries(ctx.cwd);
  const draft = ctx.ui.getEditorText();

  const result = await ctx.ui.custom<PromptStashBrowserAction>(
    (tui, theme, keybindings, done) => new PromptStashBrowser(tui, theme, keybindings, entries, done),
    {
      overlay: true,
      overlayOptions: {
        width: "80%",
        maxHeight: "80%",
        anchor: "center",
      },
    },
  );

  if (!result) {
    ctx.ui.setEditorText(draft);
  }

  return result;
}

async function runStashAction(ctx: ExtensionContext, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    ctx.ui.notify(`Prompt stash failed: ${describeError(error)}`, "error");
  }
}

export default function promptStashExtension(pi: ExtensionAPI): void {
  pi.registerCommand("stash", {
    description: "Manage stashed prompts",
    handler: async (args, ctx) => {
      await runStashAction(ctx, async () => {
        if (!ctx.hasUI) {
          ctx.ui.notify("stash requires interactive mode", "error");
          return;
        }

        const trimmed = args.trim();
        if (trimmed === "") {
          const action = await showStashBrowser(ctx);
          await applyStashSelection(ctx, action);
          return;
        }

        if (trimmed === "pop") {
          await popLatestEntry(ctx);
          return;
        }

        ctx.ui.notify("Usage: /stash or /stash pop", "warning");
      });
    },
  });

  pi.registerShortcut(Key.ctrlAlt("s"), {
    description: "Stash current prompt",
    handler: async (ctx) => {
      await runStashAction(ctx, async () => {
        if (!ctx.hasUI) {
          ctx.ui.notify("stash requires interactive mode", "error");
          return;
        }

        await stashCurrentDraft(ctx);
      });
    },
  });
}
