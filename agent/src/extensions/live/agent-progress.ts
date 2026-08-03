import type { MessageUpdateEvent } from "@earendil-works/pi-coding-agent";
import { readAssistantTextPhase } from "../../utils/pi-ai-text.js";
import type { LiveContextChannel } from "./protocol.js";

export { LiveActivityTracker } from "./activity-state.js";

const DEFAULT_FLUSH_MS = 200;

export interface LiveAgentDelta {
  channel: LiveContextChannel;
  text: string;
}

export function readLiveAgentDelta(event: MessageUpdateEvent): LiveAgentDelta | undefined {
  const update = event.assistantMessageEvent;
  if (update.type === "thinking_delta") {
    return update.delta.length === 0 ? undefined : { channel: "commentary", text: update.delta };
  }
  if (update.type !== "text_delta" || update.delta.length === 0) return undefined;
  const content = update.partial.content[update.contentIndex];
  const channel =
    content?.type === "text" && readAssistantTextPhase(content) === "commentary"
      ? "commentary"
      : "speakable";
  return { channel, text: update.delta };
}

export class LiveAgentProgressBuffer {
  readonly #flushMs: number;
  readonly #onFlush: (progress: LiveAgentDelta) => void;
  #channel: LiveContextChannel = "commentary";
  #text = "";
  #timer: NodeJS.Timeout | undefined;

  constructor(onFlush: (progress: LiveAgentDelta) => void, flushMs = DEFAULT_FLUSH_MS) {
    this.#onFlush = onFlush;
    this.#flushMs = flushMs;
  }

  push(progress: LiveAgentDelta): void {
    if (this.#text.length > 0 && progress.channel !== this.#channel) this.flush();
    this.#channel = progress.channel;
    this.#text += progress.text;
    this.#timer ??= setTimeout(() => {
      this.#timer = undefined;
      this.flush();
    }, this.#flushMs);
    this.#timer.unref?.();
  }

  flush(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#text.length === 0) return;
    const progress = { channel: this.#channel, text: this.#text } satisfies LiveAgentDelta;
    this.#text = "";
    this.#onFlush(progress);
  }

  clear(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#text = "";
  }
}
