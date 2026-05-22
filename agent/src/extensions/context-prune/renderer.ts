import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export function registerSummaryRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer("context-prune-summary", () => {
    return new Text("", 0, 0);
  });
}
