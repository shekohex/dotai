/**
 * Desktop Notification Extension
 *
 * Sends a native desktop notification when the agent finishes and is waiting for input. Uses OSC
 * 777 escape sequence - no external dependencies.
 *
 * Supported terminals: Ghostty, iTerm2, WezTerm, rxvt-unicode Not supported: Kitty (uses OSC 99),
 * Terminal.app, Windows Terminal, Alacritty
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { isRecord } from "../utils/unknown-data.js";

const ESC = "\u001B";
const BEL = "\u0007";
const ST = `${ESC}\\`;
const OSC_CONTROL_CHARACTERS = /\p{Cc}/gu;

export const terminalNotifyRuntime = {
  execFileSync,
  writeFileSync,
};

const sanitizeOscField = (value: string): string =>
  value.replaceAll(OSC_CONTROL_CHARACTERS, " ").replaceAll(/[;]/g, ":");

export const createOsc777Sequence = (title: string, body: string): string =>
  `${ESC}]777;notify;${sanitizeOscField(title)};${sanitizeOscField(body)}${BEL}`;

export const createTmuxPassthroughSequence = (sequence: string): string =>
  `${ESC}Ptmux;${ESC}${sequence.replaceAll(ESC, `${ESC}${ESC}`)}${ST}`;

export const isSshSession = (): boolean =>
  [process.env.SSH_CONNECTION, process.env.SSH_CLIENT, process.env.SSH_TTY].some(
    (value) => value !== undefined && value.length > 0,
  );

const getTmuxTty = (format: "#{pane_tty}" | "#{client_tty}"): string | null => {
  if (process.env.TMUX === undefined || process.env.TMUX.length === 0) {
    return null;
  }

  try {
    const output = terminalNotifyRuntime.execFileSync("tmux", ["display-message", "-p", format], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const paneTty = output.trim();
    return paneTty.length > 0 ? paneTty : null;
  } catch {
    return null;
  }
};

export const getTmuxPaneTty = (): string | null => getTmuxTty("#{pane_tty}");

export const getTmuxClientTty = (): string | null => getTmuxTty("#{client_tty}");

const writeNotification = (targetPath: string, sequence: string): boolean => {
  try {
    terminalNotifyRuntime.writeFileSync(targetPath, sequence, { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
};

export const notify = (title: string, body: string): void => {
  const sequence = createOsc777Sequence(title, body);
  const paneTty = getTmuxPaneTty();

  if (paneTty !== null) {
    if (isSshSession()) {
      const clientTty = getTmuxClientTty();
      if (clientTty !== null) {
        if (writeNotification(clientTty, sequence)) {
          return;
        }

        if (writeNotification(clientTty, createTmuxPassthroughSequence(sequence))) {
          return;
        }
      }
    }

    if (writeNotification(paneTty, createTmuxPassthroughSequence(sequence))) {
      return;
    }
  }

  process.stdout.write(sequence);
};

const isTextPart = (part: unknown): part is { type: "text"; text: string } =>
  isRecord(part) && part.type === "text" && typeof part.text === "string";

const extractLastAssistantText = (
  messages: Array<{ role?: string; content?: unknown }>,
): string | null => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") {
      continue;
    }

    const content = message.content;
    if (typeof content === "string") {
      return content.trim() || null;
    }

    if (Array.isArray(content)) {
      const text = content
        .filter((part) => isTextPart(part))
        .map((part) => part.text)
        .join("\n")
        .trim();
      return text || null;
    }

    return null;
  }

  return null;
};

const plainMarkdownTheme: MarkdownTheme = {
  heading: (text) => text,
  link: (text) => text,
  linkUrl: () => "",
  code: (text) => text,
  codeBlock: (text) => text,
  codeBlockBorder: () => "",
  quote: (text) => text,
  quoteBorder: () => "",
  hr: () => "",
  listBullet: () => "",
  bold: (text) => text,
  italic: (text) => text,
  strikethrough: (text) => text,
  underline: (text) => text,
};

const simpleMarkdown = (text: string, width = 80): string => {
  const markdown = new Markdown(text, 0, 0, plainMarkdownTheme);
  return markdown.render(width).join("\n");
};

export const formatNotification = (text: string | null): { title: string; body: string } => {
  const simplified = text !== null && text.length > 0 ? simpleMarkdown(text) : "";
  const normalized = simplified.replaceAll(/\s+/g, " ").trim();
  if (!normalized) {
    return { title: "Ready for input", body: "" };
  }

  const maxBody = 200;
  const body = normalized.length > maxBody ? `${normalized.slice(0, maxBody - 1)}…` : normalized;
  return { title: "π", body };
};

export default function (pi: ExtensionAPI) {
  pi.on("agent_end", (event) => {
    const lastText = extractLastAssistantText(event.messages ?? []);
    const { title, body } = formatNotification(lastText);
    notify(title, body);
  });
}
