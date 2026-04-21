import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { OpenUsageController } from "./controller.js";

export default function openUsageExtension(pi: ExtensionAPI) {
  const controller = new OpenUsageController(pi);
  controller.register();
}
