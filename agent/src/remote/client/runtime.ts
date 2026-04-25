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
import { resolveRemoteSessionTarget } from "./session-target.js";

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
  private rebindSessionHandler: ((session: RemoteAgentSession) => Promise<void>) | undefined;
  private beforeSessionInvalidateHandler: (() => void) | undefined;

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
    const workspaceCwd = requireWorkspaceCwdForCreate({
      createNewSession: options.createNewSession === true || resolvedSessionId === undefined,
      workspaceCwd: options.workspaceCwd,
    });
    const attachedSessionId =
      resolvedSessionId ??
      (
        await client.createSession({
          sessionName: options.sessionName,
          workspaceCwd,
          persistence: options.persistence,
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
    await this.switchToSession(resolveRemoteSessionTarget(sessionPath));
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
    this.beforeSessionInvalidateHandler?.();
    await this._session.dispose();
  }

  setRebindSession(rebindSession?: (session: RemoteAgentSession) => Promise<void>): void {
    this.rebindSessionHandler = rebindSession;
  }

  setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void {
    this.beforeSessionInvalidateHandler = beforeSessionInvalidate;
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
    this.beforeSessionInvalidateHandler?.();
    this._session = next;
    if (this.rebindSessionHandler) {
      await this.rebindSessionHandler(this._session);
    }
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

function requireWorkspaceCwdForCreate(input: {
  createNewSession: boolean;
  workspaceCwd?: string;
}): string | undefined {
  if (!input.createNewSession) {
    return input.workspaceCwd;
  }
  if (input.workspaceCwd === undefined || input.workspaceCwd.length === 0) {
    throw new Error("Remote new session requires workspaceCwd");
  }
  return input.workspaceCwd;
}
