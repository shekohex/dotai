import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

export const piMcpAdapterExtensionFactory = await jiti.import<ExtensionFactory>("pi-mcp-adapter", {
  default: true,
});
