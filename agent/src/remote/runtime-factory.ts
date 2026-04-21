import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { installBundledResourcePaths } from "../extensions/bundled-resources.js";
import {
  findBundledExtensionDefinitionByFactory,
  getBundledExtensionDefinitionsByHost,
  type BundledExtensionDefinition,
  type BundledExtensionHost,
} from "../extensions/index.js";

export interface RemoteRuntimeFactory {
  create(): Promise<AgentSessionRuntime>;
  dispose(): Promise<void>;
}

export interface RuntimeExtensionMetadata {
  id: string;
  host: BundledExtensionHost;
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
): RuntimeExtensionMetadata[] {
  return definitions.map((definition) => ({
    id: definition.id,
    host: definition.host,
    path: `bundled:${definition.id}`,
  }));
}

function selectRuntimeExtensions(
  options: RuntimeExtensionOptions,
  defaultHost: BundledExtensionHost,
): RuntimeFactoryExtensionSelection {
  let definitions: BundledExtensionDefinition[];
  if (options.extensionDefinitions !== undefined) {
    definitions = [...options.extensionDefinitions];
  } else if (options.extensionFactories === undefined) {
    definitions = getBundledExtensionDefinitionsByHost(defaultHost);
  } else {
    definitions = options.extensionFactories.map((factory, index) => {
      const matched = findBundledExtensionDefinitionByFactory(factory);
      if (matched) {
        return matched;
      }
      return {
        id: `custom-${index + 1}`,
        host: defaultHost,
        factory,
      } satisfies BundledExtensionDefinition;
    });
  }

  return {
    definitions,
    factories: definitions.map((definition) => definition.factory),
    metadata: toRuntimeExtensionMetadata(definitions),
  };
}

export interface InMemoryPiRuntimeFactoryOptions {
  cwd?: string;
  agentDir?: string;
  fauxApiKey?: string | null;
  extensionDefinitions?: BundledExtensionDefinition[];
  extensionFactories?: ExtensionFactory[];
}

export interface BundledPiRuntimeFactoryOptions extends RuntimeExtensionOptions {
  cwd?: string;
  agentDir?: string;
}

export class BundledPiRuntimeFactory implements RemoteRuntimeFactory {
  private readonly cwd: string;
  private readonly agentDir: string;
  private readonly extensionFactories: ExtensionFactory[];
  private readonly extensionMetadata: RuntimeExtensionMetadata[];

  constructor(options: BundledPiRuntimeFactoryOptions = {}) {
    installBundledResourcePaths();
    const extensions = selectRuntimeExtensions(options, "server-bound");
    this.cwd = options.cwd ?? process.cwd();
    this.agentDir = options.agentDir ?? getAgentDir();
    this.extensionFactories = extensions.factories;
    this.extensionMetadata = extensions.metadata;
  }

  create(): Promise<AgentSessionRuntime> {
    const createRuntime: CreateAgentSessionRuntimeFactory = async ({
      cwd,
      agentDir,
      sessionManager,
      sessionStartEvent,
    }) => {
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

    return createAgentSessionRuntime(createRuntime, {
      cwd: this.cwd,
      agentDir: this.agentDir,
      sessionManager: SessionManager.inMemory(this.cwd),
    });
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

async function createInMemoryRuntime(input: {
  cwdPromise: Promise<string>;
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

  return createAgentSessionRuntime(createRuntime, {
    cwd: await input.cwdPromise,
    agentDir: await input.agentDirPromise,
    sessionManager: SessionManager.inMemory(await input.cwdPromise),
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

export function InMemoryPiRuntimeFactory(
  options: InMemoryPiRuntimeFactoryOptions = {},
): RemoteRuntimeFactory {
  installBundledResourcePaths();
  const extensions = selectRuntimeExtensions(options, "server-bound");
  const cwdPromise =
    options.cwd !== undefined && options.cwd.length > 0
      ? Promise.resolve(options.cwd)
      : mkdtemp(join(tmpdir(), "pi-remote-cwd-"));
  const agentDirPromise =
    options.agentDir !== undefined && options.agentDir.length > 0
      ? Promise.resolve(options.agentDir)
      : mkdtemp(join(tmpdir(), "pi-remote-agent-dir-"));
  const fauxRegistration: FauxProviderRegistration = registerFauxProvider({
    provider: "pi-remote-faux",
    api: "responses",
    models: [{ id: "pi-remote-faux-1", name: "Pi Remote Faux 1" }],
  });
  const fauxApiKey =
    options.fauxApiKey === undefined ? "pi-remote-faux-local-key" : options.fauxApiKey;
  const fauxSeededResponseCount = 256;
  const extensionFactories = extensions.factories;
  const extensionMetadata = extensions.metadata;

  return {
    create(): Promise<AgentSessionRuntime> {
      return createInMemoryRuntime({
        cwdPromise,
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
  };
}
