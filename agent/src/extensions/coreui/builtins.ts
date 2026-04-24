import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@mariozechner/pi-coding-agent";

const builtInToolDefinitionCwd = process.cwd();

export const bashToolDefinition = createBashToolDefinition(builtInToolDefinitionCwd);
export const editToolDefinition = createEditToolDefinition(builtInToolDefinitionCwd);
export const readToolDefinition = createReadToolDefinition(builtInToolDefinitionCwd);
export const writeToolDefinition = createWriteToolDefinition(builtInToolDefinitionCwd);
