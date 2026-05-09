import { copyToClipboard } from "@earendil-works/pi-coding-agent";

export async function copyTextToClipboard(text: string): Promise<void> {
  if (!text.trim()) {
    throw new Error("No text to copy.");
  }

  await copyToClipboard(text);
}
