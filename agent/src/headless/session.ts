import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionCommandContextActions,
  type ExtensionUIContext,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { installBundledResourcePaths } from "../extensions/bundled-resources.js";
import { createBundledExtensionFactories } from "../extensions/index.js";
import {
  registerCoreUIToolOverrides,
  type CoreUIToolOverrides,
} from "../extensions/coreui/tool-overrides.js";

const noop = (): void => {};
const noString: string | undefined = void 0;
const resolveUndefinedString = (): Promise<string | undefined> => Promise.resolve(noString);

export interface HeadlessSessionHandle {
  readonly session: AgentSession;
  readonly sessionManager: SessionManager;
  readonly resourceLoader: DefaultResourceLoader;
  dispose(): void;
}

export interface CreateHeadlessSessionOptions {
  cwd: string;
  agentDir: string;
  sessionManager?: SessionManager;
  uiContext?: ExtensionUIContext;
  extraExtensionFactories?: InlineExtension[];
  commandContextActions?: Partial<ExtensionCommandContextActions>;
  shutdownHandler?: () => void | Promise<void>;
  onError?: (error: { event: string; error: string }) => void;
  coreUiToolOverrides?: CoreUIToolOverrides;
}

export async function createHeadlessSession(
  options: CreateHeadlessSessionOptions,
): Promise<HeadlessSessionHandle> {
  installBundledResourcePaths();
  const settingsManager = SettingsManager.create(options.cwd, options.agentDir);
  const extensionFactories = [
    ...createBundledExtensionFactories({}),
    ...(options.extraExtensionFactories ?? []),
  ];
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    extensionFactories,
  });
  await resourceLoader.reload();
  const sessionManager = options.sessionManager ?? SessionManager.create(options.cwd);
  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    resourceLoader,
    sessionManager,
  });
  const unregisterCoreUiOverrides =
    options.coreUiToolOverrides === undefined
      ? noop
      : registerCoreUIToolOverrides(sessionManager, options.coreUiToolOverrides);
  const defaultActions = createDefaultCommandActions(session);
  await session.bindExtensions({
    uiContext: options.uiContext ?? createNoopUiContext(),
    mode: "rpc",
    commandContextActions: { ...defaultActions, ...options.commandContextActions },
    shutdownHandler: options.shutdownHandler ?? noop,
    onError: options.onError ?? noop,
  });

  return {
    session,
    sessionManager,
    resourceLoader,
    dispose(): void {
      unregisterCoreUiOverrides();
      session.dispose();
    },
  };
}

function createDefaultCommandActions(session: AgentSession): ExtensionCommandContextActions {
  return {
    waitForIdle: () => session.agent.waitForIdle(),
    newSession: () => Promise.resolve({ cancelled: true }),
    fork: () => Promise.resolve({ cancelled: true }),
    navigateTree: () => Promise.resolve({ cancelled: true }),
    switchSession: () => Promise.resolve({ cancelled: true }),
    reload: async () => {
      await session.reload();
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
