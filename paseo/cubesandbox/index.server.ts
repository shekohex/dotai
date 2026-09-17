import type { PluginServerContext } from "@getpaseo/plugin/server";

import { contributeServer } from "./server/contribute.js";

export default function contribute(server: PluginServerContext) {
  return contributeServer(server);
}
