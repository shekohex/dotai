import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { createTextComponent } from "../coreui/tools.js";

export type SessionQueryRenderState = {
  startedAt?: number;
  endedAt?: number;
  interval?: ReturnType<typeof setInterval>;
  callComponent?: Text;
  callText?: string;
};

const SessionQueryRenderStateSchema = Type.Object(
  {
    startedAt: Type.Optional(Type.Number()),
    endedAt: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
);

function isSessionQueryRenderState(value: unknown): value is SessionQueryRenderState {
  return Value.Check(SessionQueryRenderStateSchema, value);
}

export function syncRenderState(
  context: { state: unknown; executionStarted: boolean; invalidate: () => void },
  isPartial: boolean,
): SessionQueryRenderState {
  const state = isSessionQueryRenderState(context.state) ? context.state : {};

  if (context.executionStarted && state.startedAt === undefined) {
    state.startedAt = Date.now();
    state.endedAt = undefined;
  }

  if (isPartial && state.startedAt !== undefined && !state.interval) {
    state.interval = setInterval(() => {
      context.invalidate();
    }, 1000);
    state.interval.unref?.();
  }

  if (!isPartial && state.startedAt !== undefined) {
    state.endedAt ??= Date.now();
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = undefined;
    }
  }

  return state;
}

export function getElapsedMs(state: SessionQueryRenderState): number | undefined {
  return state.startedAt === undefined
    ? undefined
    : (state.endedAt ?? Date.now()) - state.startedAt;
}

export function setCallComponent(
  state: SessionQueryRenderState,
  lastComponent: unknown,
  text: string,
): Text {
  const component = createTextComponent(state.callComponent ?? lastComponent, text);
  state.callComponent = component;
  state.callText = text;
  return component;
}

export function applyCollapsedSummaryToCall(state: SessionQueryRenderState, summary: string): void {
  if (
    !(state.callComponent instanceof Text) ||
    state.callText === undefined ||
    state.callText.length === 0 ||
    summary.length === 0
  ) {
    return;
  }

  state.callComponent.setText(`${state.callText}${summary}`);
}
