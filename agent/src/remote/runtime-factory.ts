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
import { bundledExtensionFactories } from "../extensions/index.js";

export interface RemoteRuntimeFactory {
  create(): Promise<AgentSessionRuntime>;
  dispose(): Promise<void>;
}

export interface InMemoryPiRuntimeFactoryOptions {
  cwd?: string;
  agentDir?: string;
  fauxApiKey?: string | null;
}

export interface BundledPiRuntimeFactoryOptions {
  cwd?: string;
  agentDir?: string;
  extensionFactories?: ExtensionFactory[];
}

export class BundledPiRuntimeFactory implements RemoteRuntimeFactory {
  private readonly cwd: string;
  private readonly agentDir: string;
  private readonly extensionFactories: ExtensionFactory[];

  constructor(options: BundledPiRuntimeFactoryOptions = {}) {
    installBundledResourcePaths();
    this.cwd = options.cwd ?? process.cwd();
    this.agentDir = options.agentDir ?? getAgentDir();
    this.extensionFactories = options.extensionFactories ?? bundledExtensionFactories;
  }

  async create(): Promise<AgentSessionRuntime> {
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
      };
    };

    return createAgentSessionRuntime(createRuntime, {
      cwd: this.cwd,
      agentDir: this.agentDir,
      sessionManager: SessionManager.inMemory(this.cwd),
    });
  }

  async dispose(): Promise<void> {}
}

export class InMemoryPiRuntimeFactory implements RemoteRuntimeFactory {
  private readonly cwdPromise: Promise<string>;
  private readonly agentDirPromise: Promise<string>;
  private readonly fauxRegistration: FauxProviderRegistration;
  private readonly fauxApiKey: string | null;
  private readonly fauxSeededResponseCount: number;

  constructor(options: InMemoryPiRuntimeFactoryOptions = {}) {
    this.cwdPromise = options.cwd
      ? Promise.resolve(options.cwd)
      : mkdtemp(join(tmpdir(), "pi-remote-cwd-"));
    this.agentDirPromise = options.agentDir
      ? Promise.resolve(options.agentDir)
      : mkdtemp(join(tmpdir(), "pi-remote-agent-dir-"));
    this.fauxRegistration = registerFauxProvider({
      provider: "pi-remote-faux",
      api: "responses",
      models: [{ id: "pi-remote-faux-1", name: "Pi Remote Faux 1" }],
    });
    this.fauxApiKey =
      options.fauxApiKey === undefined ? "pi-remote-faux-local-key" : options.fauxApiKey;
    this.fauxSeededResponseCount = 256;
  }

  async create(): Promise<AgentSessionRuntime> {
    const pendingResponses = this.fauxRegistration.getPendingResponseCount();
    if (pendingResponses < this.fauxSeededResponseCount) {
      this.fauxRegistration.appendResponses(
        Array.from({ length: this.fauxSeededResponseCount - pendingResponses }, () =>
          fauxAssistantMessage("Remote faux response"),
        ),
      );
    }

    const model = this.fauxRegistration.getModel();
    const createRuntime: CreateAgentSessionRuntimeFactory = async ({
      cwd,
      agentDir,
      sessionManager,
      sessionStartEvent,
    }) => {
      const services = await createAgentSessionServices({ cwd, agentDir });
      if (this.fauxApiKey !== null) {
        services.authStorage.setRuntimeApiKey(model.provider, this.fauxApiKey);
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
      };
    };

    return createAgentSessionRuntime(createRuntime, {
      cwd: await this.cwdPromise,
      agentDir: await this.agentDirPromise,
      sessionManager: SessionManager.inMemory(await this.cwdPromise),
    });
  }

  async dispose(): Promise<void> {
    this.fauxRegistration.unregister();
  }
}
