import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getCoreUIToolOverride } from "./tool-overrides.js";

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
  getOverride: (ctx: ExtensionContext, cwd: string) => TTool | undefined,
): TTool {
  if (!tool.execute) {
    return tool;
  }

  return {
    ...tool,
    execute: (...args: Parameters<NonNullable<TTool["execute"]>>) => {
      const ctx = args[4] as ExtensionContext | undefined;
      const cwd = resolveToolCwd(ctx);
      const boundTool = (ctx === undefined ? undefined : getOverride(ctx, cwd)) ?? createTool(cwd);
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
  (ctx, cwd) => getCoreUIToolOverride(ctx.sessionManager, "bash")?.(cwd),
);

export const editToolDefinition: EditToolDefinition = bindToolExecutionToContextCwd(
  createEditToolDefinition(builtInToolDefinitionCwd),
  createEditToolDefinition,
  (ctx, cwd) => getCoreUIToolOverride(ctx.sessionManager, "edit")?.(cwd),
);

export const readToolDefinition: ReadToolDefinition = bindToolExecutionToContextCwd(
  createReadToolDefinition(builtInToolDefinitionCwd),
  createReadToolDefinition,
  (ctx, cwd) => getCoreUIToolOverride(ctx.sessionManager, "read")?.(cwd),
);

export const writeToolDefinition: WriteToolDefinition = bindToolExecutionToContextCwd(
  createWriteToolDefinition(builtInToolDefinitionCwd),
  createWriteToolDefinition,
  (ctx, cwd) => getCoreUIToolOverride(ctx.sessionManager, "write")?.(cwd),
);
