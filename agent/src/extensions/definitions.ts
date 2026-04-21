import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { groupedExtensionsA } from "./definitions-group-a.js";
import { groupedExtensionsB } from "./definitions-group-b.js";
import { groupedExtensionsC } from "./definitions-group-c.js";

export interface GroupedExtensionDefinition {
  id: string;
  factory: ExtensionFactory;
}

export { groupedExtensionsA, groupedExtensionsB, groupedExtensionsC };
