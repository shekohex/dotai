import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeCommands } from "./client/commands";
import { contributeTimeline } from "./client/timeline";

export default function contribute(client: PluginClientContext) {
  contributeTimeline(client);
  contributeCommands(client);
  return () => {};
}
