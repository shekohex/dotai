import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  fauxAssistantMessage,
  registerFauxProvider,
  type FauxProviderRegistration,
} from "@mariozechner/pi-ai";
import {
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionFactory,
} from "@mariozechner/pi-coding-agent";
import { getDefaultSessionDir } from "../../node_modules/@mariozechner/pi-coding-agent/dist/core/session-manager.js";
import { installBundledResourcePaths } from "../extensions/bundled-resources.js";
import {
  bundledExtensionDefinitions,
  findBundledExtensionDefinitionByFactory,
  type BundledExtensionDefinition,
} from "../extensions/index.js";

export interface RemoteRuntimeFactory {
  create(request?: { cwd?: string }): Promise<AgentSessionRuntime>;
  load?(request: LoadRemoteRuntimeRequest): Promise<AgentSessionRuntime>;
  dispose(): Promise<void>;
  getSessionCatalogRoot?(): string | undefined;
}

export interface LoadRemoteRuntimeRequest {
  sessionId: string;
  sessionPath: string;
  cwd: string;
}

export interface RuntimeExtensionMetadata {
  id: string;
  runtime: "server" | "client";
  path: string;
}

export interface RuntimeExtensionRuntime extends AgentSessionRuntime {
  remoteExtensionMetadata?: RuntimeExtensionMetadata[];
}

interface RuntimeExtensionOptions {
  extensionDefinitions?: BundledExtensionDefinition[];
  extensionFactories?: ExtensionFactory[];
}

interface RuntimeFactoryExtensionSelection {
  definitions: BundledExtensionDefinition[];
  factories: ExtensionFactory[];
  metadata: RuntimeExtensionMetadata[];
}

function toRuntimeExtensionMetadata(
  definitions: BundledExtensionDefinition[],
  runtime: RuntimeExtensionMetadata["runtime"],
): RuntimeExtensionMetadata[] {
  return definitions.map((definition) => ({
    id: definition.id,
    runtime,
    path: `bundled:${definition.id}`,
  }));
}

function selectRuntimeExtensions(
  options: RuntimeExtensionOptions,
  runtime: RuntimeExtensionMetadata["runtime"],
): RuntimeFactoryExtensionSelection {
  let definitions: BundledExtensionDefinition[];
  if (options.extensionDefinitions !== undefined) {
    definitions = [...options.extensionDefinitions];
  } else if (options.extensionFactories === undefined) {
    definitions = [...bundledExtensionDefinitions];
  } else {
    definitions = options.extensionFactories.map((factory, index) => {
      const matched = findBundledExtensionDefinitionByFactory(factory);
      if (matched) {
        return matched;
      }
      return {
        id: `custom-${index + 1}`,
        factory,
      } satisfies BundledExtensionDefinition;
    });
  }

  return {
    definitions,
    factories: definitions.map((definition) => definition.factory),
    metadata: toRuntimeExtensionMetadata(definitions, runtime),
  };
}

export interface InMemoryPiRuntimeFactoryOptions {
  cwd?: string;
  agentDir?: string;
  sessionDir?: string;
  persistSessions?: boolean;
  fauxApiKey?: string | null;
  extensionDefinitions?: BundledExtensionDefinition[];
  extensionFactories?: ExtensionFactory[];
}

export interface BundledPiRuntimeFactoryOptions extends RuntimeExtensionOptions {
  cwd?: string;
  agentDir?: string;
  sessionDir?: string;
}

export class BundledPiRuntimeFactory implements RemoteRuntimeFactory {
  private readonly cwd: string;
  private readonly agentDir: string;
  private readonly sessionDir: string;
  private readonly sessionCatalogRoot: string;
  private readonly extensionFactories: ExtensionFactory[];
  private readonly extensionMetadata: RuntimeExtensionMetadata[];

  constructor(options: BundledPiRuntimeFactoryOptions = {}) {
    installBundledResourcePaths();
    const extensions = selectRuntimeExtensions(options, "server");
    this.cwd = options.cwd ?? process.cwd();
    this.agentDir = options.agentDir ?? getAgentDir();
    this.sessionDir = options.sessionDir ?? getDefaultSessionDir(this.cwd, this.agentDir);
    this.sessionCatalogRoot =
      options.sessionDir !== undefined && options.sessionDir.length > 0
        ? resolve(options.sessionDir)
        : join(this.agentDir, "sessions");
    this.extensionFactories = extensions.factories;
    this.extensionMetadata = extensions.metadata;
  }

  create(request?: { cwd?: string }): Promise<AgentSessionRuntime> {
    const cwd = request?.cwd ?? this.cwd;
    return createAgentSessionRuntime(this.createRuntimeFactory(), {
      cwd,
      agentDir: this.agentDir,
      sessionManager: SessionManager.create(cwd, this.sessionDir),
    });
  }

  load(request: LoadRemoteRuntimeRequest): Promise<AgentSessionRuntime> {
    const sessionManager = SessionManager.open(request.sessionPath);
    return createAgentSessionRuntime(this.createRuntimeFactory(), {
      cwd: sessionManager.getCwd(),
      agentDir: this.agentDir,
      sessionManager,
      sessionStartEvent: { type: "session_start", reason: "resume" },
    });
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }

  getSessionCatalogRoot(): string {
    return this.sessionCatalogRoot;
  }

  private createRuntimeFactory(): CreateAgentSessionRuntimeFactory {
    return async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        resourceLoaderOptions: {
          extensionFactories: this.extensionFactories,
        },
      });
      const created = await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
      });
      return {
        ...created,
        services,
        diagnostics: [...services.diagnostics],
        remoteExtensionMetadata: [...this.extensionMetadata],
      };
    };
  }
}

async function createInMemoryRuntime(input: {
  cwdPromise: Promise<string>;
  agentDirPromise: Promise<string>;
  sessionDirPromise: Promise<string | undefined>;
  persistSessions: boolean;
  fauxRegistration: FauxProviderRegistration;
  fauxSeededResponseCount: number;
  fauxApiKey: string | null;
  extensionFactories: ExtensionFactory[];
  extensionMetadata: RuntimeExtensionMetadata[];
}): Promise<AgentSessionRuntime> {
  const pendingResponses = input.fauxRegistration.getPendingResponseCount();
  if (pendingResponses < input.fauxSeededResponseCount) {
    input.fauxRegistration.appendResponses(
      Array.from({ length: input.fauxSeededResponseCount - pendingResponses }, () =>
        fauxAssistantMessage("Remote faux response"),
      ),
    );
  }

  const model = input.fauxRegistration.getModel();
  if (model === undefined) {
    throw new Error("In-memory faux provider did not return a model");
  }
  const createRuntime = buildInMemoryCreateRuntime(input, model);

  return createAgentSessionRuntime(createRuntime, {
    cwd: await input.cwdPromise,
    agentDir: await input.agentDirPromise,
    sessionManager: input.persistSessions
      ? SessionManager.create(
          await input.cwdPromise,
          (await input.sessionDirPromise) ??
            getDefaultSessionDir(await input.cwdPromise, await input.agentDirPromise),
        )
      : SessionManager.inMemory(await input.cwdPromise),
  });
}

async function loadInMemoryRuntime(input: {
  sessionPath: string;
  agentDirPromise: Promise<string>;
  fauxRegistration: FauxProviderRegistration;
  fauxSeededResponseCount: number;
  fauxApiKey: string | null;
  extensionFactories: ExtensionFactory[];
  extensionMetadata: RuntimeExtensionMetadata[];
}): Promise<AgentSessionRuntime> {
  const pendingResponses = input.fauxRegistration.getPendingResponseCount();
  if (pendingResponses < input.fauxSeededResponseCount) {
    input.fauxRegistration.appendResponses(
      Array.from({ length: input.fauxSeededResponseCount - pendingResponses }, () =>
        fauxAssistantMessage("Remote faux response"),
      ),
    );
  }

  const model = input.fauxRegistration.getModel();
  if (model === undefined) {
    throw new Error("In-memory faux provider did not return a model");
  }

  const createRuntime = buildInMemoryCreateRuntime(input, model);
  const agentDir = await input.agentDirPromise;
  const sessionManager = SessionManager.open(input.sessionPath);

  return createAgentSessionRuntime(createRuntime, {
    cwd: sessionManager.getCwd(),
    agentDir,
    sessionManager,
    sessionStartEvent: { type: "session_start", reason: "resume" },
  });
}

function buildInMemoryCreateRuntime(
  input: {
    fauxApiKey: string | null;
    extensionFactories: ExtensionFactory[];
    extensionMetadata: RuntimeExtensionMetadata[];
  },
  model: NonNullable<ReturnType<FauxProviderRegistration["getModel"]>>,
): CreateAgentSessionRuntimeFactory {
  return async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: {
        extensionFactories: input.extensionFactories,
      },
    });
    if (input.fauxApiKey !== null) {
      services.authStorage.setRuntimeApiKey(model.provider, input.fauxApiKey);
    }
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model,
    });
    return {
      ...created,
      services,
      diagnostics: [...services.diagnostics],
      remoteExtensionMetadata: [...input.extensionMetadata],
    };
  };
}

function normalizeSessionDir(sessionDir: string | undefined): string | undefined {
  if (sessionDir !== undefined && sessionDir.length > 0) {
    return sessionDir;
  }
  return undefined;
}

function getSessionCatalogRoot(input: {
  agentDir: string | undefined;
  sessionDir: string | undefined;
  persistSessions: boolean;
}): string | undefined {
  if (!input.persistSessions) {
    return undefined;
  }
  if (input.sessionDir !== undefined && input.sessionDir.length > 0) {
    return resolve(input.sessionDir);
  }
  if (input.agentDir !== undefined && input.agentDir.length > 0) {
    return join(input.agentDir, "sessions");
  }
  return undefined;
}

export function InMemoryPiRuntimeFactory(
  options: InMemoryPiRuntimeFactoryOptions = {},
): RemoteRuntimeFactory {
  installBundledResourcePaths();
  const extensions = selectRuntimeExtensions(options, "server");
  const cwdPromise =
    options.cwd !== undefined && options.cwd.length > 0
      ? Promise.resolve(options.cwd)
      : mkdtemp(join(tmpdir(), "pi-remote-cwd-"));
  const agentDirPromise =
    options.agentDir !== undefined && options.agentDir.length > 0
      ? Promise.resolve(options.agentDir)
      : mkdtemp(join(tmpdir(), "pi-remote-agent-dir-"));
  const sessionDirPromise = Promise.resolve(normalizeSessionDir(options.sessionDir));
  const fauxRegistration: FauxProviderRegistration = registerFauxProvider({
    provider: "pi-remote-faux",
    api: "responses",
    models: [{ id: "pi-remote-faux-1", name: "Pi Remote Faux 1" }],
  });
  const fauxApiKey =
    options.fauxApiKey === undefined ? "pi-remote-faux-local-key" : options.fauxApiKey;
  const fauxSeededResponseCount = 256;
  const persistSessions = options.persistSessions ?? false;
  const sessionCatalogRoot = getSessionCatalogRoot({
    agentDir: options.agentDir,
    sessionDir: options.sessionDir,
    persistSessions,
  });
  const extensionFactories = extensions.factories;
  const extensionMetadata = extensions.metadata;

  return {
    create(request?: { cwd?: string }): Promise<AgentSessionRuntime> {
      return createInMemoryRuntime({
        cwdPromise: Promise.resolve(request?.cwd).then((cwd) => cwd ?? cwdPromise),
        agentDirPromise,
        sessionDirPromise,
        persistSessions,
        fauxRegistration,
        fauxSeededResponseCount,
        fauxApiKey,
        extensionFactories,
        extensionMetadata,
      });
    },
    load(request: LoadRemoteRuntimeRequest): Promise<AgentSessionRuntime> {
      return loadInMemoryRuntime({
        sessionPath: request.sessionPath,
        agentDirPromise,
        fauxRegistration,
        fauxSeededResponseCount,
        fauxApiKey,
        extensionFactories,
        extensionMetadata,
      });
    },
    dispose(): Promise<void> {
      fauxRegistration.unregister();
      return Promise.resolve();
    },
    getSessionCatalogRoot(): string | undefined {
      return sessionCatalogRoot;
    },
  };
}
