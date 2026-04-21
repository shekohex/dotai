import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
import { REVIEW_PRESETS, TOGGLE_CUSTOM_INSTRUCTIONS_VALUE, type ReviewTarget } from "./deps.js";

type SmartDefaultPreset = "uncommitted" | "baseBranch" | "commit";

type ShowReviewSelectorInput = {
  smartDefault: SmartDefaultPreset;
  getCustomInstructions: () => string | undefined;
  setCustomInstructions: (instructions: string | undefined) => void;
  resolvePresetTargetSelection: (
    selection: string,
  ) => ReviewTarget | Promise<ReviewTarget | null> | null;
};

function buildReviewPresetSelectionItems(
  presetItems: SelectItem[],
  customInstructions: string | undefined,
): SelectItem[] {
  const hasCustomInstructions = customInstructions !== undefined && customInstructions.length > 0;
  return [
    ...presetItems,
    {
      value: TOGGLE_CUSTOM_INSTRUCTIONS_VALUE,
      label: hasCustomInstructions
        ? "Remove custom review instructions"
        : "Add custom review instructions",
      description: hasCustomInstructions ? "(currently set)" : "(applies to all review modes)",
    },
  ];
}

function showReviewPresetMenu(
  ctx: ExtensionContext,
  items: SelectItem[],
  smartDefaultIndex: number,
): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Select a review preset"))));

    const selectList = new SelectList(items, Math.min(items.length, 10), {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });
    if (smartDefaultIndex >= 0) {
      selectList.setSelectedIndex(smartDefaultIndex);
    }

    selectList.onSelect = (item) => {
      done(item.value);
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

async function updateCustomReviewInstructions(
  ctx: ExtensionContext,
  customInstructions: string | undefined,
  setCustomInstructions: (instructions: string | undefined) => void,
): Promise<void> {
  if (customInstructions !== undefined && customInstructions.length > 0) {
    setCustomInstructions(undefined);
    ctx.ui.notify("Custom review instructions removed", "info");
    return;
  }

  const editedInstructions = await ctx.ui.editor(
    "Enter custom review instructions (applies to all review modes):",
    "",
  );
  if (typeof editedInstructions !== "string" || editedInstructions.trim().length === 0) {
    ctx.ui.notify("Custom review instructions not changed", "info");
    return;
  }

  setCustomInstructions(editedInstructions);
  ctx.ui.notify("Custom review instructions saved", "info");
}

export async function showReviewSelector(
  ctx: ExtensionContext,
  input: ShowReviewSelectorInput,
): Promise<ReviewTarget | null> {
  const presetItems: SelectItem[] = REVIEW_PRESETS.map((preset) => ({
    value: preset.value,
    label: preset.label,
    description: preset.description,
  }));
  const smartDefaultIndex = presetItems.findIndex((item) => item.value === input.smartDefault);

  while (true) {
    const result = await showReviewPresetMenu(
      ctx,
      buildReviewPresetSelectionItems(presetItems, input.getCustomInstructions()),
      smartDefaultIndex,
    );

    if (result === null || result.length === 0) {
      return null;
    }

    if (result === TOGGLE_CUSTOM_INSTRUCTIONS_VALUE) {
      await updateCustomReviewInstructions(
        ctx,
        input.getCustomInstructions(),
        input.setCustomInstructions,
      );
      continue;
    }

    const target = await input.resolvePresetTargetSelection(result);
    if (target) {
      return target;
    }
  }
}
