import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import {
  createTmuxPassthroughSequence,
  getTmuxClientTty,
  getTmuxPaneTty,
  isSshSession,
  terminalNotifyRuntime,
} from "../terminal-notify.js";
import { createPiOscSequence, type PiOscEnvelope, type PiOscV1Event } from "./encoder.js";
import type { PiOscV1Payload } from "./schemas.js";

export const piOscRuntime = {
  now: () => Date.now(),
  randomId: () => randomUUID(),
};

const boundedText = (value: string, maxLength: number): string =>
  value.length <= maxLength ? value : value.slice(0, maxLength);

const writePiOscSequence = (sequence: string): void => {
  const paneTty = getTmuxPaneTty();
  if (paneTty === null) {
    terminalNotifyRuntime.stdoutWrite(sequence);
    return;
  }

  if (isSshSession()) {
    const clientTty = getTmuxClientTty();
    if (clientTty !== null) {
      try {
        terminalNotifyRuntime.writeFileSync(clientTty, sequence, { encoding: "utf8" });
        return;
      } catch {}

      try {
        terminalNotifyRuntime.writeFileSync(clientTty, createTmuxPassthroughSequence(sequence), {
          encoding: "utf8",
        });
        return;
      } catch {}
    }
  }

  try {
    terminalNotifyRuntime.writeFileSync(paneTty, createTmuxPassthroughSequence(sequence), {
      encoding: "utf8",
    });
    return;
  } catch {}

  terminalNotifyRuntime.stdoutWrite(sequence);
};

export const createPiOscEnvelope = (
  ctx: ExtensionContext,
  seq: number,
  data: PiOscV1Payload,
): PiOscEnvelope => ({
  id: piOscRuntime.randomId(),
  ts: piOscRuntime.now(),
  source: "agent",
  sessionId: ctx.sessionManager.getSessionId(),
  cwd: ctx.cwd,
  seq,
  data,
});

export const emitPiOscEvent = (
  eventName: PiOscV1Event,
  ctx: ExtensionContext,
  seq: number,
  data: PiOscV1Payload,
): void => {
  writePiOscSequence(createPiOscSequence(eventName, createPiOscEnvelope(ctx, seq, data)));
};

export default function piOscExtension(pi: ExtensionAPI): void {
  let seq = 0;
  const emit = (eventName: PiOscV1Event, ctx: ExtensionContext, data: PiOscV1Payload): void => {
    seq += 1;
    emitPiOscEvent(eventName, ctx, seq, data);
  };

  pi.on("session_start", (event, ctx) => {
    emit("hello", ctx, { protocol: 1, extension: "pi-osc", version: 1 });
    emit("agent.session", ctx, { state: "started", reason: event.reason });
  });

  pi.on("agent_start", (_event, ctx) => {
    emit("agent.run", ctx, { state: "running" });
    emit("agent.progress", ctx, { state: "active" });
  });

  pi.on("agent_end", (_event, ctx) => {
    emit("agent.run", ctx, { state: "idle" });
    emit("agent.progress", ctx, { state: "clear" });
  });

  pi.on("turn_start", (event, ctx) => {
    emit("agent.turn", ctx, { state: "running", turnIndex: event.turnIndex });
  });

  pi.on("turn_end", (event, ctx) => {
    emit("agent.turn", ctx, { state: "complete", turnIndex: event.turnIndex });
  });

  pi.on("tool_execution_start", (event, ctx) => {
    emit("agent.tool", ctx, {
      toolCallId: boundedText(event.toolCallId, 128),
      toolName: boundedText(event.toolName, 128),
      state: "running",
    });
  });

  pi.on("tool_execution_end", (event, ctx) => {
    emit("agent.tool", ctx, {
      toolCallId: boundedText(event.toolCallId, 128),
      toolName: boundedText(event.toolName, 128),
      state: "complete",
      isError: event.isError,
    });
  });

  pi.on("session_before_compact", (_event, ctx) => {
    emit("agent.compaction", ctx, { state: "preparing" });
  });

  pi.on("session_compact", (_event, ctx) => {
    emit("agent.compaction", ctx, { state: "complete" });
  });

  pi.on("after_provider_response", (event, ctx) => {
    if (event.status !== 429) {
      return;
    }

    emit("agent.alert", ctx, {
      kind: "provider",
      severity: "warning",
      title: "Provider rate limit",
      body: "Provider returned HTTP 429.",
      statusCode: event.status,
    });
  });
}
