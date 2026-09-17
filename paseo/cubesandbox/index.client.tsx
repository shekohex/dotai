import type { PluginClientContext } from "@getpaseo/plugin/client";

import { WorkSandboxes } from "./client/work-sandboxes.js";

export default function contribute(client: PluginClientContext) {
  client.addSurface("cube-sandboxes", WorkSandboxes);
  client.addSidebarItem({
    id: "cube-sandboxes",
    title: "Cube Sandboxes",
    icon: "Box",
    surface: "cube-sandboxes",
  });
  return () => {};
}
