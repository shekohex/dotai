import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function calculateTotalCost(ctx: ExtensionContext): number {
  let totalCost = 0;

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      totalCost += entry.message.usage.cost.total;
    }
  }

  return totalCost;
}
