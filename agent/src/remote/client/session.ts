import {
  AuthStorage,
  DefaultResourceLoader,
  type ExtensionFactory,
  ModelRegistry,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { RemoteApiClient } from "../remote-api-client.js";
import type { RemoteExtensionMetadata, SessionSnapshot } from "../schemas.js";
import type { RemoteSessionContract } from "./session-deps.js";
export type {
  RemoteRuntimeAuthOptions,
  RemoteRuntimeContract,
  RemoteRuntimeOptions,
} from "./session-deps.js";
import {
  createRemoteResourceLoader,
  patchModelRegistryForRemoteCatalog,
  readRemoteSettingsSnapshot,
} from "./session-deps.js";
import { RemoteAgentSessionCapabilitiesApi } from "./session/capabilities-api.js";

interface RemoteAgentSessionCreateOptions {
  snapshot?: SessionSnapshot;
  fallbackCwd?: string;
  agentDir: string;
  clientExtensions?: RemoteExtensionMetadata[];
  clientExtensionFactories?: ExtensionFactory[];
}

export class RemoteAgentSession
  extends RemoteAgentSessionCapabilitiesApi
  implements RemoteSessionContract
{
  static async create(
    client: RemoteApiClient,
    sessionId: string,
    options: RemoteAgentSessionCreateOptions,
  ): Promise<RemoteAgentSession> {
    const snapshot = options.snapshot ?? (await client.getSessionSnapshot(sessionId));
    const sessionCwd = snapshot.cwd ?? options.fallbackCwd ?? process.cwd();
    const remoteSettings = readRemoteSettingsSnapshot(snapshot);
    const settingsManager = SettingsManager.inMemory(remoteSettings);
    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    let session: RemoteAgentSession | undefined;
    configureRemoteModelStateBindings({
      modelRegistry,
      sessionRef: () => session,
    });
    const sessionManager = SessionManager.inMemory(sessionCwd);
    const clientExtensionLoader = new DefaultResourceLoader({
      cwd: sessionCwd,
      agentDir: options.agentDir,
      extensionFactories: options.clientExtensionFactories ?? [],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    await clientExtensionLoader.reload();
    const resourceLoader = createSessionResourceLoader({
      snapshot,
      clientExtensionLoader,
      getExtensionsMetadata: () =>
        session
          ? session.getCombinedExtensionsMetadata()
          : [
              ...snapshot.extensions.map((extension) => ({ ...extension })),
              ...(options.clientExtensions ?? []).map((extension) => ({ ...extension })),
            ],
      clientExtensions: options.clientExtensions ?? [],
    });
    session = new RemoteAgentSession(
      client,
      snapshot.sessionId,
      snapshot,
      settingsManager,
      modelRegistry,
      sessionManager,
      resourceLoader,
      {
        clientExtensions: options.clientExtensions ?? [],
        clientExtensionLoader,
      },
    );
    session.startPolling();
    return session;
  }
}

function configureRemoteModelStateBindings(input: {
  modelRegistry: ModelRegistry;
  sessionRef: () => RemoteAgentSession | undefined;
}): void {
  patchModelRegistryForRemoteCatalog(input.modelRegistry, () => {
    return input.sessionRef()?.getRemoteAvailableModels() ?? [];
  });
}

function createSessionResourceLoader(input: {
  snapshot: SessionSnapshot;
  clientExtensionLoader: DefaultResourceLoader;
  getExtensionsMetadata: () => RemoteExtensionMetadata[];
  clientExtensions: RemoteExtensionMetadata[];
}): ResourceLoader {
  return createRemoteResourceLoader({
    baseLoader: input.clientExtensionLoader,
    snapshot: input.snapshot,
    getExtensionsMetadata: input.getExtensionsMetadata,
    clientExtensions: input.clientExtensions,
  });
}
