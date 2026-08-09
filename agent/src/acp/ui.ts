import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createNoopUiContext } from "../headless/session.js";

export interface AcpUi {
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  editor(title: string, prefill?: string): Promise<string | undefined>;
  notify(message: string, level?: "info" | "warning" | "error"): void;
}

export function formatAcpNotification(
  message: string,
  level: "info" | "warning" | "error" = "info",
): string {
  let label = "Notice";
  if (level === "warning") label = "Warning";
  if (level === "error") label = "Error";
  const quote = message
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `\n\n> **${label}**\n>\n${quote}\n\n`;
}

export function createExtensionUiContext(ui: AcpUi): ExtensionUIContext {
  return {
    ...createNoopUiContext(),
    select: (title, options) => ui.select(title, options),
    confirm: (title, message) => ui.confirm(title, message),
    input: (title, placeholder) => ui.input(title, placeholder),
    editor: (title, prefill) => ui.editor(title, prefill),
    notify: (message, level) => {
      ui.notify(message, level);
    },
  };
}
