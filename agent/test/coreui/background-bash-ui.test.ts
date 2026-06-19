import { describe, expect, test } from "vitest";
import { renderBackgroundShellLines } from "../../src/extensions/coreui/background-bash-ui.js";
import type { BackgroundShellRun } from "../../src/extensions/coreui/background-bash-types.js";

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
    backend: "tmux",
    muxSession: "pi-background",
    targetId: "@1",
    targetLabel: "tmux window @1",
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
        run({ id: "failed", status: "failed", targetId: "@2", targetLabel: "tmux window @2" }),
        run({ id: "killed", status: "killed", targetId: "@3", targetLabel: "tmux window @3" }),
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

  test("renders missing rows as recent tracked state", () => {
    const lines = renderBackgroundShellLines(
      [
        run({
          completedAt: 2_000,
          status: "missing",
          targetId: "@9",
          targetLabel: "tmux window @9",
        }),
      ],
      120,
      theme,
      "compact",
      4,
    );

    expect(lines[0]).toContain("1 recent");
    expect(lines[1]).toContain("missing");
    expect(lines[1]).toContain("@9");
  });

  test("hides overflow rows in compact mode", () => {
    const lines = renderBackgroundShellLines(
      [
        run({ id: "1" }),
        run({ id: "2", targetId: "@2", targetLabel: "tmux window @2" }),
        run({ id: "3", targetId: "@3", targetLabel: "tmux window @3" }),
        run({ id: "4", targetId: "@4", targetLabel: "tmux window @4" }),
      ],
      120,
      theme,
      "compact",
      3,
    );

    expect(lines.at(-1)).toContain("hidden background shells");
  });
});
