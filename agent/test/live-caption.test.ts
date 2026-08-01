import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { LIVE_TRANSCRIPT_ENTRY_TYPE } from "../src/extensions/live/controller.js";
import { _test as liveExtensionTest } from "../src/extensions/live/index.js";

function recordingTheme() {
  const foregroundColors: string[] = [];
  const backgroundColors: string[] = [];
  return {
    theme: {
      fg(color: string, text: string) {
        foregroundColors.push(color);
        return `<${color}>${text}</${color}>`;
      },
      bg(color: string, text: string) {
        backgroundColors.push(color);
        return `<${color}>${text}</${color}>`;
      },
      bold(text: string) {
        return `<bold>${text}</bold>`;
      },
      italic(text: string) {
        return `<italic>${text}</italic>`;
      },
    },
    foregroundColors,
    backgroundColors,
  };
}

describe("Pi Live transcript captions", () => {
  it("renders a compact user caption with thinking-like muted styling", () => {
    const { theme, foregroundColors, backgroundColors } = recordingTheme();
    const component = liveExtensionTest.renderTranscriptEntry(
      {
        type: "custom",
        customType: "live-transcript",
        id: "caption-1",
        parentId: null,
        timestamp: "2026-04-01T10:00:00.000Z",
        data: {
          role: "user",
          text: "Check the latest tests",
          turn: 1,
          timestamp: Date.UTC(2026, 3, 1, 10),
        },
      },
      { expanded: false },
      theme as never,
    );

    expect(component.render(200)[0]?.trim()).toBe(
      "<customMessageLabel><bold>[live · you]</bold></customMessageLabel> <italic><dim>Check the latest tests</dim></italic>",
    );
    expect(foregroundColors).toEqual(["customMessageLabel", "dim"]);
    expect(foregroundColors).not.toContain("accent");
    expect(backgroundColors).not.toContain("customMessageBg");
  });

  it("labels assistant captions as Pi speech", () => {
    const { theme } = recordingTheme();
    const component = liveExtensionTest.renderTranscriptEntry(
      {
        type: "custom",
        customType: "live-transcript",
        id: "caption-2",
        parentId: null,
        timestamp: "2026-04-01T10:00:00.000Z",
        data: {
          role: "assistant",
          text: "Tests are passing",
          turn: 1,
          timestamp: Date.UTC(2026, 3, 1, 10),
        },
      },
      { expanded: false },
      theme as never,
    );

    expect(component.render(200)[0]).toContain("[live · pi]");
    expect(component.render(200)[0]).not.toContain("[live · you]");
  });

  it("preserves expanded multiline captions with aligned continuation and timestamp lines", () => {
    const timestamp = Date.UTC(2026, 3, 1, 10);
    const { theme } = recordingTheme();
    const component = liveExtensionTest.renderTranscriptEntry(
      {
        type: "custom",
        customType: "live-transcript",
        id: "caption-3",
        parentId: null,
        timestamp: "2026-04-01T10:00:00.000Z",
        data: {
          role: "assistant",
          text: "First line\nSecond line",
          turn: 1,
          timestamp,
        },
      },
      { expanded: true },
      theme as never,
    );
    const renderedLines = component.render(300).map((line) => line.slice(1).trimEnd());
    const continuationIndent = " ".repeat("[live · pi] ".length);

    expect(renderedLines).toEqual([
      "<customMessageLabel><bold>[live · pi]</bold></customMessageLabel> <italic><dim>First line</dim></italic>",
      `${continuationIndent}<italic><dim>Second line</dim></italic>`,
      `${continuationIndent}<dim>${new Date(timestamp).toLocaleString()}</dim>`,
    ]);
  });

  it("flattens multiline captions and omits timestamps when collapsed", () => {
    const timestamp = Date.UTC(2026, 3, 1, 10);
    const { theme } = recordingTheme();
    const component = liveExtensionTest.renderTranscriptEntry(
      {
        type: "custom",
        customType: "live-transcript",
        id: "caption-4",
        parentId: null,
        timestamp: "2026-04-01T10:00:00.000Z",
        data: {
          role: "user",
          text: "First line\n  Second line",
          turn: 1,
          timestamp,
        },
      },
      { expanded: false },
      theme as never,
    );
    const renderedLines = component.render(300);

    expect(renderedLines).toHaveLength(1);
    expect(renderedLines[0]).toContain("First line Second line");
    expect(renderedLines[0]).not.toContain(new Date(timestamp).toLocaleString());
  });

  it("keeps the safe fallback for restored entries without data", () => {
    const { theme } = recordingTheme();
    const component = liveExtensionTest.renderTranscriptEntry(
      {
        type: "custom",
        customType: "live-transcript",
        id: "caption-old",
        parentId: null,
        timestamp: "2026-04-01T10:00:00.000Z",
      },
      { expanded: false },
      theme as never,
    );

    expect(component.render(200)[0]).toContain("[live · pi]");
    expect(component.render(200)[0]).toContain("Voice transcript unavailable");
  });

  it("registers a component renderer for live transcript entries", () => {
    const { theme } = recordingTheme();
    let registeredType: string | undefined;
    let registeredRenderer:
      | ((entry: never, options: never, rendererTheme: never) => unknown)
      | undefined;
    liveExtensionTest.registerTranscriptRenderer({
      registerEntryRenderer(type: string, renderer: typeof registeredRenderer) {
        registeredType = type;
        registeredRenderer = renderer;
      },
    } as never);

    expect(registeredType).toBe("live-transcript");
    const component = registeredRenderer?.(
      {
        type: "custom",
        customType: "live-transcript",
        id: "caption-registered",
        parentId: null,
        timestamp: "2026-04-01T10:00:00.000Z",
        data: {
          role: "user",
          text: "Registered",
          turn: 1,
          timestamp: Date.UTC(2026, 3, 1, 10),
        },
      } as never,
      { expanded: false } as never,
      theme as never,
    );
    expect(component).toMatchObject({ render: expect.any(Function) });
  });

  it("restores transcript entries with the same custom type while excluding them from context", () => {
    const sessionDirectory = mkdtempSync(join(tmpdir(), "pi-live-caption-"));
    try {
      const session = SessionManager.create("/workspace", sessionDirectory);
      session.appendMessage({
        role: "user",
        content: [{ type: "text", text: "Start session" }],
        timestamp: Date.UTC(2026, 3, 1, 9),
      });
      session.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "Session started" }],
        stopReason: "stop",
        timestamp: Date.UTC(2026, 3, 1, 9, 1),
      });
      session.appendCustomEntry(LIVE_TRANSCRIPT_ENTRY_TYPE, {
        role: "user",
        text: "Persist this caption",
        turn: 1,
        timestamp: Date.UTC(2026, 3, 1, 10),
      });
      const sessionFile = session.getSessionFile();
      if (sessionFile === undefined) throw new Error("Expected persisted session file");

      const restoredSession = SessionManager.open(sessionFile);
      const restoredEntry = restoredSession.getEntries().at(-1);

      expect(restoredEntry).toMatchObject({
        type: "custom",
        customType: LIVE_TRANSCRIPT_ENTRY_TYPE,
        data: { role: "user", text: "Persist this caption", turn: 1 },
      });
      expect(restoredSession.buildSessionContext().messages).toHaveLength(2);
      expect(restoredSession.buildSessionContext().messages).not.toContainEqual(
        expect.objectContaining({ customType: LIVE_TRANSCRIPT_ENTRY_TYPE }),
      );
    } finally {
      rmSync(sessionDirectory, { recursive: true });
    }
  });
});
