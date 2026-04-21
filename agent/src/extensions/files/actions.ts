import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";

export type FileAction = "reveal" | "quicklook" | "open" | "edit" | "addToPrompt" | "diff";

const isFileAction = (value: string): value is FileAction =>
  value === "reveal" ||
  value === "quicklook" ||
  value === "open" ||
  value === "edit" ||
  value === "addToPrompt" ||
  value === "diff";

const createActionItem = (
  value: FileAction,
  label: string,
): SelectItem & { value: FileAction } => ({
  value,
  label,
});

export function showActionSelector(
  ctx: ExtensionContext,
  options: { canQuickLook: boolean; canEdit: boolean; canDiff: boolean },
): Promise<FileAction | null> {
  const actions = buildActionSelectorItems(options);

  return ctx.ui.custom<FileAction | null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Choose action"))));

    const selectList = new SelectList(actions, actions.length, {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });

    selectList.onSelect = (item) => {
      done(isFileAction(item.value) ? item.value : null);
    };
    selectList.onCancel = () => {
      done(null);
    };

    container.addChild(selectList);
    container.addChild(new Text(theme.fg("dim", "Press enter to confirm or esc to cancel")));
    container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

function buildActionSelectorItems(options: {
  canQuickLook: boolean;
  canEdit: boolean;
  canDiff: boolean;
}): Array<SelectItem & { value: FileAction }> {
  return [
    ...(options.canDiff ? [createActionItem("diff", "Diff in Zed")] : []),
    createActionItem("reveal", "Reveal in Finder"),
    createActionItem("open", "Open"),
    createActionItem("addToPrompt", "Add to prompt"),
    ...(options.canQuickLook ? [createActionItem("quicklook", "Open in Quick Look")] : []),
    ...(options.canEdit ? [createActionItem("edit", "Edit")] : []),
  ];
}
