import { describe, expect, it, vi } from "vitest";

const transportState = vi.hoisted(() => ({
  emit: undefined as ((event: unknown) => void) | undefined,
}));

vi.mock("../src/extensions/live/transport.js", () => ({
  CodexLiveControl: class {
    constructor(options: { onEvent(event: unknown): void }) {
      transportState.emit = options.onEvent;
    }

    async connect(): Promise<string> {
      return "answer-sdp";
    }

    async send(): Promise<void> {}

    async close(): Promise<void> {}
  },
}));

import {
  LIVE_TRANSCRIPT_ENTRY_TYPE,
  LiveSessionController,
  type LiveTranscript,
} from "../src/extensions/live/controller.js";

describe("Pi Live transcript persistence", () => {
  it("keeps partial transcripts panel-only and persists a final transcript exactly once", async () => {
    const appendedEntries: Array<{ customType: string; data: unknown }> = [];
    const panelTranscripts: Array<LiveTranscript | undefined> = [];
    let appNotificationHandler: ((method: string, params: unknown) => void) | undefined;
    const connection = {
      open: true,
      onNotification(handler: typeof appNotificationHandler) {
        appNotificationHandler = handler;
      },
      onRequest() {},
      onClose() {},
      onState() {},
      notify() {},
      async request(method: string): Promise<unknown> {
        if (method === "webrtc.createOffer") return { sdp: "offer-sdp" };
        if (method === "codex.createAttestation") {
          return {
            supported: false,
            locale: "en-US",
            timezone: "UTC",
            appSessionId: "app-session-1",
          };
        }
        if (method === "webrtc.acceptAnswer") return {};
        throw new Error(`Unexpected request: ${method}`);
      },
      close() {},
    };
    const pairing = {
      accept: async () => connection,
      close: async () => {},
    };
    const screenCapture = {
      attach() {},
      close: async () => {},
    };
    const controller = new LiveSessionController({
      pi: {
        appendEntry(customType: string, data: unknown) {
          appendedEntries.push({ customType, data });
        },
      } as never,
      context: {
        sessionManager: {
          getSessionId: () => "session-1",
          getBranch: () => [],
        },
      } as never,
      pairing: pairing as never,
      callbacks: {
        onPhase() {},
        onLevels() {},
        onTranscript(transcript) {
          panelTranscripts.push(transcript);
        },
        onAgentFailure() {},
        onTerminal() {},
      },
      identity: {
        firstName: "Pi",
        lastName: "Live",
        username: "pi-live",
        displayName: "Pi Live",
      },
      appOpenTimeoutMs: 1_000,
      coordinator: {
        subscribe: () => () => {},
        snapshot: () => ({ threads: [] }),
        buildSessionSummary: () => "No active workspace threads.",
      } as never,
      screenCapture: screenCapture as never,
    });

    const starting = controller.start();
    await vi.waitFor(() => expect(transportState.emit).toBeTypeOf("function"));
    appNotificationHandler?.("webrtc.opened", {});
    await starting;

    transportState.emit?.({ type: "input_transcript.added", item: { text: "Check" } });
    transportState.emit?.({ type: "input_transcript.added", item: { text: "Check tests" } });

    expect(panelTranscripts.at(-1)).toEqual({
      role: "user",
      text: "Check tests",
      turn: 1,
      final: false,
    });
    expect(appendedEntries).toEqual([]);

    transportState.emit?.({
      type: "turn.done",
      turn: { role: "user", transcript: "Check tests" },
    });
    transportState.emit?.({
      type: "turn.done",
      turn: { role: "user", transcript: "Check tests" },
    });

    expect(appendedEntries).toHaveLength(1);
    expect(appendedEntries[0]).toMatchObject({
      customType: LIVE_TRANSCRIPT_ENTRY_TYPE,
      data: { role: "user", text: "Check tests", turn: 1 },
    });
    expect(panelTranscripts.at(-1)).toEqual({
      role: "user",
      text: "Check tests",
      turn: 1,
      final: true,
    });

    await controller.stop();
  });
});
