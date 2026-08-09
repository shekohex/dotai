import type { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";

export type CoreUIToolName = "read" | "write" | "edit" | "bash";
type CoreUIToolDefinitionMap = {
  read: ReturnType<typeof createReadToolDefinition>;
  write: ReturnType<typeof createWriteToolDefinition>;
  edit: ReturnType<typeof createEditToolDefinition>;
  bash: ReturnType<typeof createBashToolDefinition>;
};
export type CoreUIToolOverrides = {
  [Name in CoreUIToolName]?: (cwd: string) => CoreUIToolDefinitionMap[Name];
};

const overridesBySession = new WeakMap<object, CoreUIToolOverrides>();

export function registerCoreUIToolOverrides(
  sessionManager: SessionManager,
  overrides: CoreUIToolOverrides,
): () => void {
  overridesBySession.set(sessionManager, overrides);
  return () => overridesBySession.delete(sessionManager);
}

export function getCoreUIToolOverride(
  sessionManager: object,
  toolName: "read",
): ((cwd: string) => CoreUIToolDefinitionMap["read"]) | undefined;
export function getCoreUIToolOverride(
  sessionManager: object,
  toolName: "write",
): ((cwd: string) => CoreUIToolDefinitionMap["write"]) | undefined;
export function getCoreUIToolOverride(
  sessionManager: object,
  toolName: "edit",
): ((cwd: string) => CoreUIToolDefinitionMap["edit"]) | undefined;
export function getCoreUIToolOverride(
  sessionManager: object,
  toolName: "bash",
): ((cwd: string) => CoreUIToolDefinitionMap["bash"]) | undefined;
export function getCoreUIToolOverride(sessionManager: object, toolName: CoreUIToolName): unknown {
  return overridesBySession.get(sessionManager)?.[toolName];
}
