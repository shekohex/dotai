import {
  getAgentDir,
  type ExtensionFactory,
  type ModelRegistry,
  type ResourceLoader,
  type SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { RemoteApiClient } from "../remote-api-client.js";
import type { RemoteRuntimeContract, RemoteRuntimeOptions } from "./contracts.js";
import { RemoteAgentSession } from "./session.js";

type RemoteExtensionBindings = Parameters<RemoteAgentSession["bindExtensions"]>[0];

export class RemoteAgentSessionRuntime implements RemoteRuntimeContract {
  private readonly client: RemoteApiClient;
  private cwd: string;
  private readonly agentDir: string;
  private readonly clientExtensionMetadata: NonNullable<
    RemoteRuntimeOptions["clientExtensionMetadata"]
  >;
  private readonly clientExtensionFactories: ExtensionFactory[];
  private _session: RemoteAgentSession;
  private latestExtensionBindings: RemoteExtensionBindings | undefined;

  private constructor(
    client: RemoteApiClient,
    session: RemoteAgentSession,
    options: {
      cwd: string;
      agentDir: string;
      clientExtensionMetadata: NonNullable<RemoteRuntimeOptions["clientExtensionMetadata"]>;
      clientExtensionFactories: ExtensionFactory[];
    },
  ) {
    this.client = client;
    this._session = session;
    this.cwd = options.cwd;
    this.agentDir = options.agentDir;
    this.clientExtensionMetadata = options.clientExtensionMetadata;
    this.clientExtensionFactories = options.clientExtensionFactories;
  }

  static async create(options: RemoteRuntimeOptions): Promise<RemoteAgentSessionRuntime> {
    const fallbackCwd = options.cwd ?? process.cwd();
    const agentDir = options.agentDir ?? getAgentDir();
    const clientExtensionMetadata = options.clientExtensionMetadata ?? [];
    const clientExtensionFactories = options.clientExtensionFactories ?? [];
    const client = new RemoteApiClient({
      origin: options.origin,
      auth: options.auth,
      connectionId: options.connectionId,
      clientCapabilities: options.clientCapabilities,
      fetchImpl: options.fetchImpl,
    });

    await client.authenticate();
    const appSnapshot = await client.getAppSnapshot();
    const resolvedSessionId =
      options.createNewSession === true
        ? undefined
        : (options.sessionId ?? appSnapshot.defaultAttachSessionId);
    const attachedSessionId =
      resolvedSessionId ??
      (
        await client.createSession({
          sessionName: options.sessionName,
          workspaceCwd: options.workspaceCwd,
        })
      ).sessionId;
    const snapshot = await client.getSessionSnapshot(attachedSessionId);
    const authoritativeCwd = snapshot.cwd ?? fallbackCwd;
    const session = await RemoteAgentSession.create(client, attachedSessionId, {
      snapshot,
      fallbackCwd,
      agentDir,
      clientExtensions: clientExtensionMetadata,
      clientExtensionFactories,
    });
    const runtime = new RemoteAgentSessionRuntime(client, session, {
      cwd: authoritativeCwd,
      agentDir,
      clientExtensionMetadata,
      clientExtensionFactories,
    });
    runtime.instrumentSessionBindings(session);

    return runtime;
  }

  get session(): RemoteAgentSession {
    return this._session;
  }

  get diagnostics(): readonly [] {
    return [];
  }

  get modelFallbackMessage(): undefined {
    return undefined;
  }

  get services(): {
    settingsManager: SettingsManager;
    modelRegistry: ModelRegistry;
    resourceLoader: ResourceLoader;
  } {
    return {
      settingsManager: this._session.settingsManager,
      modelRegistry: this._session.modelRegistry,
      resourceLoader: this._session.resourceLoader,
    };
  }

  async newSession(
    options?: Parameters<RemoteRuntimeContract["newSession"]>[0],
  ): Promise<{ cancelled: boolean }> {
    const created = await this.client.createSession({ workspaceCwd: this.cwd });
    await this.switchToSession(created.sessionId);
    if (options?.setup) {
      await options.setup(this._session.sessionManager);
    }
    if (options?.withSession) {
      await options.withSession(this._session.createReplacedSessionContext());
    }
    return { cancelled: false };
  }

  async switchSession(
    sessionPath: string,
    options?: Parameters<RemoteRuntimeContract["switchSession"]>[1],
  ): Promise<{ cancelled: boolean }> {
    await this.switchToSession(sessionPath);
    if (options?.withSession) {
      await options.withSession(this._session.createReplacedSessionContext());
    }
    return { cancelled: false };
  }

  fork(_entryId: string): Promise<{ cancelled: boolean; selectedText?: string }> {
    return Promise.resolve({ cancelled: true });
  }

  importFromJsonl(_inputPath: string, _cwdOverride?: string): Promise<{ cancelled: boolean }> {
    return Promise.resolve({ cancelled: true });
  }

  async dispose(): Promise<void> {
    await this._session.dispose();
  }

  private async switchToSession(sessionId: string): Promise<void> {
    const previous = this._session;
    const snapshot = await this.client.getSessionSnapshot(sessionId);
    const next = await RemoteAgentSession.create(this.client, sessionId, {
      snapshot,
      fallbackCwd: this.cwd,
      agentDir: this.agentDir,
      clientExtensions: this.clientExtensionMetadata,
      clientExtensionFactories: this.clientExtensionFactories,
    });
    this.instrumentSessionBindings(next);
    if (this.latestExtensionBindings) {
      await next.bindExtensions(this.latestExtensionBindings);
    }
    this.cwd = snapshot.cwd ?? this.cwd;
    this._session = next;
    await previous.dispose();
  }

  private instrumentSessionBindings(session: RemoteAgentSession): void {
    const originalBindExtensions = session.bindExtensions.bind(session);
    session.bindExtensions = async (bindings) => {
      this.latestExtensionBindings = bindings;
      await originalBindExtensions(bindings);
    };
  }
}
