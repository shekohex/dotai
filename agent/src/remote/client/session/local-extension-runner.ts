import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, ImageContent, Model, TextContent } from "@mariozechner/pi-ai";
import type {
  ContextUsage,
  ModelRegistry,
  PromptTemplate,
  ResourceLoader,
  SessionManager,
  Skill,
} from "@mariozechner/pi-coding-agent";
import { ExtensionRunner } from "../../../../node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/runner.js";
import type {
  CompactOptions,
  ExtensionActions,
  ExtensionContextActions,
  GetCommandsHandler,
  GetAllToolsHandler,
} from "../../../../node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.js";

export type RemoteLocalExtensionRunner = ExtensionRunner;

type SendCustomMessageInput<T = unknown> = {
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  details?: T;
};

type RemoteToolInfo = {
  name: string;
  description: string;
  parameters: unknown;
  sourceInfo: unknown;
};

export function createRemoteLocalExtensionRunner(input: {
  resourceLoader: ResourceLoader;
  cwd: string;
  sessionManager: SessionManager;
  modelRegistry: ModelRegistry;
  promptTemplates: ReadonlyArray<PromptTemplate>;
  readSkills: () => ReadonlyArray<Skill>;
  readModel: () => Model<Api> | undefined;
  isIdle: () => boolean;
  readSignal: () => AbortSignal | undefined;
  abort: () => Promise<void>;
  hasPendingMessages: () => boolean;
  shutdown: () => void;
  getContextUsage: () => ContextUsage | undefined;
  compact: (options?: CompactOptions) => void;
  getSystemPrompt: () => string;
  sendCustomMessage: (
    message: SendCustomMessageInput,
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ) => Promise<void>;
  sendUserMessage: (
    content: string | (TextContent | ImageContent)[],
    options?: { deliverAs?: "steer" | "followUp" },
  ) => Promise<void>;
  appendEntry: (customType: string, data: unknown) => void;
  setSessionName: (name: string) => void;
  getSessionName: () => string | undefined;
  setLabel: (entryId: string, label?: string) => void;
  getActiveToolNames: () => string[];
  getAllTools: () => RemoteToolInfo[];
  refreshTools: () => Promise<void>;
  setActiveToolsByName: (toolNames: string[]) => void;
  resolveModel: (provider: string, id: string) => Model<Api> | undefined;
  setModel: (model: Model<Api>) => Promise<void>;
  hasConfiguredAuth: (model: Model<Api>) => boolean;
  getThinkingLevel: () => ThinkingLevel;
  setThinkingLevel: (level: ThinkingLevel) => void;
}): RemoteLocalExtensionRunner | undefined {
  const extensionsResult = input.resourceLoader.getExtensions();
  if (extensionsResult.extensions.length === 0) {
    return undefined;
  }

  const runner = new ExtensionRunner(
    extensionsResult.extensions,
    extensionsResult.runtime,
    input.cwd,
    input.sessionManager,
    input.modelRegistry,
  );

  const actions = createExtensionActions(input, runner);
  const contextActions = createExtensionContextActions(input);
  runner.bindCore(actions, contextActions);
  return runner;
}

function createExtensionActions(
  input: Parameters<typeof createRemoteLocalExtensionRunner>[0],
  runner: RemoteLocalExtensionRunner,
): ExtensionActions {
  return {
    sendMessage: (message, options) => {
      void input.sendCustomMessage(message, options).catch((error: unknown) => {
        runner.emitError({
          extensionPath: "<runtime>",
          event: "send_message",
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    sendUserMessage: (content, options) => {
      void input.sendUserMessage(content, options).catch((error: unknown) => {
        runner.emitError({
          extensionPath: "<runtime>",
          event: "send_user_message",
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    appendEntry: (customType, data) => {
      input.appendEntry(customType, data);
    },
    setSessionName: (name) => {
      input.setSessionName(name);
    },
    getSessionName: () => input.getSessionName(),
    setLabel: (entryId, label) => {
      input.setLabel(entryId, label);
    },
    getActiveTools: () => input.getActiveToolNames(),
    getAllTools: () => input.getAllTools().filter((tool) => isToolInfoLike(tool)),
    setActiveTools: (toolNames) => {
      input.setActiveToolsByName(toolNames);
    },
    refreshTools: () => {
      void input.refreshTools().catch((error: unknown) => {
        runner.emitError({
          extensionPath: "<runtime>",
          event: "refresh_tools",
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    getCommands: () => buildSlashCommands(runner, input.promptTemplates, input.readSkills()),
    setModel: async (model) => {
      const resolvedModel = input.resolveModel(model.provider, model.id);
      if (!resolvedModel || !input.hasConfiguredAuth(resolvedModel)) {
        return false;
      }
      await input.setModel(resolvedModel);
      return true;
    },
    getThinkingLevel: () => input.getThinkingLevel(),
    setThinkingLevel: (level) => {
      input.setThinkingLevel(level);
    },
  };
}

function isToolInfoLike(tool: RemoteToolInfo): tool is ReturnType<GetAllToolsHandler>[number] {
  return (
    tool !== null &&
    typeof tool === "object" &&
    typeof tool.name === "string" &&
    typeof tool.description === "string" &&
    tool.parameters !== null &&
    typeof tool.parameters === "object" &&
    tool.sourceInfo !== null &&
    typeof tool.sourceInfo === "object"
  );
}

function createExtensionContextActions(
  input: Parameters<typeof createRemoteLocalExtensionRunner>[0],
): ExtensionContextActions {
  return {
    getModel: () => input.readModel(),
    isIdle: () => input.isIdle(),
    getSignal: () => input.readSignal(),
    abort: () => {
      void input.abort();
    },
    hasPendingMessages: () => input.hasPendingMessages(),
    shutdown: () => {
      input.shutdown();
    },
    getContextUsage: () => input.getContextUsage(),
    compact: (compactOptions) => {
      input.compact(compactOptions);
    },
    getSystemPrompt: () => input.getSystemPrompt(),
  };
}

function buildSlashCommands(
  extensionRunner: RemoteLocalExtensionRunner,
  promptTemplates: ReadonlyArray<PromptTemplate>,
  skills: ReadonlyArray<Skill>,
): ReturnType<GetCommandsHandler> {
  const extensionCommands = extensionRunner.getRegisteredCommands().map((command) => ({
    name: command.invocationName,
    description: command.description,
    source: "extension" as const,
    sourceInfo: command.sourceInfo,
  }));
  const templateCommands = promptTemplates.map((template) => ({
    name: template.name,
    description: template.description,
    source: "prompt" as const,
    sourceInfo: template.sourceInfo,
  }));
  const skillCommands = skills.map((skill) => ({
    name: `skill:${skill.name}`,
    description: skill.description,
    source: "skill" as const,
    sourceInfo: skill.sourceInfo,
  }));

  return [...extensionCommands, ...templateCommands, ...skillCommands];
}
