import {
  AuthStorage,
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
  patchSettingsManagerForRemoteModelSettings,
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
      settingsManager,
      sessionRef: () => session,
    });
    const sessionManager = SessionManager.inMemory(sessionCwd);
    const resourceLoader = await createSessionResourceLoader({
      sessionCwd,
      agentDir: options.agentDir,
      snapshot,
      getExtensionsMetadata: () =>
        session
          ? session.getCombinedExtensionsMetadata()
          : [
              ...snapshot.extensions.map((extension) => ({ ...extension })),
              ...(options.clientExtensions ?? []).map((extension) => ({ ...extension })),
            ],
      clientExtensions: options.clientExtensions ?? [],
      clientExtensionFactories: options.clientExtensionFactories ?? [],
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
        agentDir: options.agentDir,
        clientExtensions: options.clientExtensions ?? [],
      },
    );
    session.startPolling();
    return session;
  }
}

function configureRemoteModelStateBindings(input: {
  modelRegistry: ModelRegistry;
  settingsManager: SettingsManager;
  sessionRef: () => RemoteAgentSession | undefined;
}): void {
  patchModelRegistryForRemoteCatalog(input.modelRegistry, () => {
    return input.sessionRef()?.getRemoteAvailableModels() ?? [];
  });
  patchSettingsManagerForRemoteModelSettings(input.settingsManager, () => {
    return input.sessionRef()?.getRemoteModelSettings() ?? {};
  });
}

function createSessionResourceLoader(input: {
  sessionCwd: string;
  agentDir: string;
  snapshot: SessionSnapshot;
  getExtensionsMetadata: () => RemoteExtensionMetadata[];
  clientExtensions: RemoteExtensionMetadata[];
  clientExtensionFactories: ExtensionFactory[];
}): Promise<ResourceLoader> {
  return createRemoteResourceLoader({
    cwd: input.sessionCwd,
    agentDir: input.agentDir,
    snapshot: input.snapshot,
    getExtensionsMetadata: input.getExtensionsMetadata,
    clientExtensionFactories: input.clientExtensionFactories,
    clientExtensions: input.clientExtensions,
  });
}
