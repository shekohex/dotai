import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@mariozechner/pi-coding-agent";

const builtInToolDefinitionCwd = process.cwd();

type BashToolDefinition = ReturnType<typeof createBashToolDefinition>;
type ReadToolDefinition = ReturnType<typeof createReadToolDefinition>;
type EditToolDefinition = ReturnType<typeof createEditToolDefinition>;
type WriteToolDefinition = ReturnType<typeof createWriteToolDefinition>;

function resolveToolCwd(ctx: ExtensionContext | undefined): string {
  return ctx?.cwd ?? builtInToolDefinitionCwd;
}

function bindToolExecutionToContextCwd<TTool extends { execute?: (...args: never[]) => unknown }>(
  tool: TTool,
  createTool: (cwd: string) => TTool,
): TTool {
  if (!tool.execute) {
    return tool;
  }

  return {
    ...tool,
    execute: (...args: Parameters<NonNullable<TTool["execute"]>>) => {
      const ctx = args[4] as ExtensionContext | undefined;
      const boundTool = createTool(resolveToolCwd(ctx));
      const execute = boundTool.execute;
      if (!execute) {
        throw new Error("Tool missing execute");
      }
      return execute(...args);
    },
  };
}

export const bashToolDefinition: BashToolDefinition = bindToolExecutionToContextCwd(
  createBashToolDefinition(builtInToolDefinitionCwd),
  createBashToolDefinition,
);

export const editToolDefinition: EditToolDefinition = bindToolExecutionToContextCwd(
  createEditToolDefinition(builtInToolDefinitionCwd),
  createEditToolDefinition,
);

export const readToolDefinition: ReadToolDefinition = bindToolExecutionToContextCwd(
  createReadToolDefinition(builtInToolDefinitionCwd),
  createReadToolDefinition,
);

export const writeToolDefinition: WriteToolDefinition = bindToolExecutionToContextCwd(
  createWriteToolDefinition(builtInToolDefinitionCwd),
  createWriteToolDefinition,
);
