/**
 * Session construction for remote mode. Builds an in-process AgentSession with the full bundled
 * extension set (mirrors the subagent-SDK LiteRuntime pattern).
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

import { installBundledResourcePaths } from "../extensions/bundled-resources.js";
import { bundledExtensionFactories } from "../extensions/index.js";

const noop = (): void => {};
const noString: string | undefined = void 0;
const resolveUndefinedString = (): Promise<string | undefined> => Promise.resolve(noString);

export interface RemoteSessionHandle {
  readonly session: AgentSession;
  dispose(): void;
}

export interface CreateRemoteSessionOptions {
  cwd: string;
  agentDir: string;
}

export async function createRemoteSession(
  options: CreateRemoteSessionOptions,
): Promise<RemoteSessionHandle> {
  installBundledResourcePaths();
  const settingsManager = SettingsManager.create(options.cwd, options.agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    extensionFactories: bundledExtensionFactories,
  });
  await resourceLoader.reload();
  const sessionManager = SessionManager.create(options.cwd);
  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    resourceLoader,
    sessionManager,
  });

  // Bind extensions with a no-op UI context. Tools/hooks/mode-prompts are
  // already active from the constructor; this wires UI defaults + the mode flag
  // extensions use to decide their behavior.
  await session.bindExtensions({
    uiContext: createNoopUiContext(),
    mode: "rpc",
    commandContextActions: {
      waitForIdle: () => session.agent.waitForIdle(),
      newSession: () => Promise.resolve({ cancelled: true }),
      fork: () => Promise.resolve({ cancelled: true }),
      navigateTree: () => Promise.resolve({ cancelled: true }),
      switchSession: () => Promise.resolve({ cancelled: true }),
      reload: async () => {
        await session.reload();
      },
    },
    shutdownHandler: () => {},
    onError: () => {},
  });

  return {
    get session() {
      return session;
    },
    dispose(): void {
      session.dispose();
    },
  };
}

export function createNoopUiContext(): ExtensionUIContext {
  return {
    select: resolveUndefinedString,
    confirm: () => Promise.resolve(false),
    input: resolveUndefinedString,
    notify: noop,
    onTerminalInput: () => noop,
    setStatus: noop,
    setWorkingMessage: noop,
    setWorkingVisible: noop,
    setWorkingIndicator: noop,
    setHiddenThinkingLabel: noop,
    setWidget: noop,
    setFooter: noop,
    setHeader: noop,
    setTitle: noop,
    custom: () => Promise.resolve<never>(undefined!),
    pasteToEditor: noop,
    setEditorText: noop,
    getEditorText: () => "",
    editor: resolveUndefinedString,
    addAutocompleteProvider: noop,
    setEditorComponent: noop,
    getEditorComponent: () => {},
    get theme() {
      return undefined!;
    },
    getAllThemes: () => [],
    getTheme: () => {},
    setTheme: () => ({ success: false, error: "not supported" }),
    getToolsExpanded: () => false,
    setToolsExpanded: noop,
  };
}
