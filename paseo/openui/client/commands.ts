import type { PluginClientContext } from "@getpaseo/plugin/client";
import { attachRpc } from "../shared/attach";

/** `/openui`: a running agent cannot gain the render tool, so teach it the ```openui block instead. */
export function contributeCommands(client: PluginClientContext): void {
  client.addSlashCommand({
    name: "openui",
    description: "Let this agent answer with interactive UI (```openui blocks)",
    argumentHint: "",
    context: "agent",
    async onSubmit({ agent, rpc }) {
      await rpc(attachRpc, { agentId: agent.id });
    },
  });
}
