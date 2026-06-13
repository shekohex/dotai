import { describe, expect, test } from "vitest";
import { renderBackgroundShellLines } from "../../src/extensions/coreui/tmux-background-ui.js";
import type { BackgroundShellRun } from "../../src/extensions/coreui/tmux-background-types.js";

const theme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
  italic: (text: string) => text,
};

function run(input: Partial<BackgroundShellRun> = {}): BackgroundShellRun {
  return {
    command: "npm run dev",
    cwd: "/repo",
    exitFile: "/tmp/run.exit",
    id: "run-1",
    outputFile: "/tmp/run.out",
    startedAt: 1_000,
    status: "running",
    tmuxSession: "pi-background",
    windowId: "@1",
    ...input,
  };
}

describe("renderBackgroundShellLines", () => {
  test("renders compact running summary", () => {
    const lines = renderBackgroundShellLines([run()], 120, theme, "compact", 4);

    expect(lines[0]).toContain("Background shells · 1 tracked · 1 running");
    expect(lines[1]).toContain("npm run dev · running");
    expect(lines[1]).toContain("@1");
  });

  test("renders failed and killed counts", () => {
    const lines = renderBackgroundShellLines(
      [
        run({ id: "failed", status: "failed", windowId: "@2" }),
        run({ id: "killed", status: "killed", windowId: "@3" }),
      ],
      120,
      theme,
      "compact",
      4,
    );

    expect(lines[0]).toContain("2 recent");
    expect(lines[0]).toContain("1 failed");
    expect(lines[0]).toContain("1 killed");
  });

  test("hides overflow rows in compact mode", () => {
    const lines = renderBackgroundShellLines(
      [
        run({ id: "1" }),
        run({ id: "2", windowId: "@2" }),
        run({ id: "3", windowId: "@3" }),
        run({ id: "4", windowId: "@4" }),
      ],
      120,
      theme,
      "compact",
      3,
    );

    expect(lines.at(-1)).toContain("hidden background shells");
  });
});
