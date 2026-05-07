import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
  buildTextInputPrompt,
  buildTextSelectPrompt,
  parseTextSelectReply,
} from "./discuss-phase-text.js";
import type { DiscussCheckpoint } from "../state/schema.js";

export function promptSelect(
  ctx: ExtensionCommandContext,
  checkpoint: DiscussCheckpoint,
  title: string,
  options: string[],
  textReplyReader: { consume: () => string | undefined },
): Promise<string | undefined> {
  if (checkpoint.text) {
    checkpoint.pendingPrompt = buildTextSelectPrompt(title, options);
    checkpoint.promptOptions = [];
  } else {
    checkpoint.pendingPrompt = title;
    checkpoint.promptOptions = options;
  }
  if (checkpoint.auto) {
    return Promise.resolve(options[0]);
  }
  if (checkpoint.text) {
    const reply = textReplyReader.consume();
    return Promise.resolve(reply === undefined ? undefined : parseTextSelectReply(reply, options));
  }
  if (!ctx.hasUI) {
    return Promise.resolve(options[options.length]);
  }
  return ctx.ui.select(title, options);
}

export function promptInput(
  ctx: ExtensionCommandContext,
  checkpoint: DiscussCheckpoint,
  title: string,
  placeholder: string,
  fallback: string,
  textReplyReader: { consume: () => string | undefined },
): Promise<string | undefined> {
  checkpoint.pendingPrompt = checkpoint.text ? buildTextInputPrompt(title, placeholder) : title;
  checkpoint.promptOptions = [];
  if (checkpoint.auto) {
    return Promise.resolve(fallback);
  }
  if (checkpoint.text) {
    return Promise.resolve(textReplyReader.consume());
  }
  if (!ctx.hasUI) {
    return Promise.resolve([placeholder][1]);
  }
  return ctx.ui.input(title, placeholder);
}
