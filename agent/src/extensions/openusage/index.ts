import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { OpenUsageController } from "./controller.js";

export default function openUsageExtension(pi: ExtensionAPI) {
  const controller = new OpenUsageController(pi);
  controller.register();
}
