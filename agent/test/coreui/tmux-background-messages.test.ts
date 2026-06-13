import { describe, expect, test } from "vitest";
import { formatPollPreview } from "../../src/extensions/coreui/tmux-background-messages.js";

const theme = {
  bg: (_color: string, text: string) => text,
  bold: (text: string) => `**${text}**`,
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  italic: (text: string) => `_${text}_`,
};

describe("formatPollPreview", () => {
  test("labels poll output as last lines with omitted count", () => {
    const lines = formatPollPreview(
      [
        "Background command poll: @15",
        "",
        "_...3 earlier lines_",
        "",
        "_Last 5 lines:_",
        "",
        "```log",
        "polled 14",
        "polled 15",
        "polled 16",
        "polled 17",
        "polled 18",
        "```",
      ].join("\n"),
      { pollLineCount: 5, pollOmittedLineCount: 3 },
      theme,
    );

    expect(lines).toContain("_<dim>...3 earlier lines</dim>_");
    expect(lines).toContain("_<muted>Last 5 lines:</muted>_");
    expect(lines).toContain("<dim>```log</dim>");
    expect(lines).toContain("<muted>polled 18</muted>");
  });
});
