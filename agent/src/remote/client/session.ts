import {
  AuthStorage,
  ModelRegistry,
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
  patchModelRegistryForRemoteCatalog,
  patchSettingsManagerForRemoteModelSettings,
} from "./session-deps.js";
import { RemoteAgentSessionCapabilitiesApi } from "./session/capabilities-api.js";

export class RemoteAgentSession
  extends RemoteAgentSessionCapabilitiesApi
  implements RemoteSessionContract
{
  static async create(
    client: RemoteApiClient,
    sessionId: string,
    options: {
      snapshot?: SessionSnapshot;
      fallbackCwd?: string;
      agentDir: string;
      clientExtensions?: RemoteExtensionMetadata[];
    },
  ): Promise<RemoteAgentSession> {
    const snapshot = options.snapshot ?? (await client.getSessionSnapshot(sessionId));
    const sessionCwd = snapshot.cwd ?? options.fallbackCwd ?? process.cwd();
    const settingsManager = SettingsManager.create(sessionCwd, options.agentDir);
    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    let session: RemoteAgentSession | undefined;
    patchModelRegistryForRemoteCatalog(
      modelRegistry,
      () => session?.getRemoteAvailableModels() ?? [],
    );
    patchSettingsManagerForRemoteModelSettings(
      settingsManager,
      () => session?.getRemoteModelSettings() ?? {},
    );
    const sessionManager = SessionManager.inMemory(sessionCwd);
    session = new RemoteAgentSession(
      client,
      snapshot.sessionId,
      snapshot,
      settingsManager,
      modelRegistry,
      sessionManager,
      {
        agentDir: options.agentDir,
        clientExtensions: options.clientExtensions ?? [],
      },
    );
    session.startPolling();
    return session;
  }
}
