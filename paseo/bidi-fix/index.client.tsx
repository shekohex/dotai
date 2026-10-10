import type { PluginClientContext } from "@getpaseo/plugin/client";

import { installBidiFix } from "./client/web.js";

export default function contribute(_client: PluginClientContext) {
  return installBidiFix();
}
