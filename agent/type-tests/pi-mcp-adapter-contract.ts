import type { PiMcpAdapterModuleContract } from "../src/extensions/pi-mcp-adapter.js";
import type piMcpAdapterExtensionFactory from "pi-mcp-adapter";
import type { registerMcpServer } from "pi-mcp-adapter";

interface UpstreamPiMcpAdapterModule {
  default: typeof piMcpAdapterExtensionFactory;
  registerMcpServer: typeof registerMcpServer;
}
type AssertAssignableToLocalContract<T extends PiMcpAdapterModuleContract> = T;

export type PiMcpAdapterContractCheck = AssertAssignableToLocalContract<UpstreamPiMcpAdapterModule>;
