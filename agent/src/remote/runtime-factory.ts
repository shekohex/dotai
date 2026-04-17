import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider, type FauxProviderRegistration } from "@mariozechner/pi-ai";
import {
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
} from "@mariozechner/pi-coding-agent";

export interface RemoteRuntimeFactory {
  create(): Promise<AgentSessionRuntime>;
  dispose(): Promise<void>;
}

export interface InMemoryPiRuntimeFactoryOptions {
  cwd?: string;
  agentDir?: string;
  fauxApiKey?: string | null;
}

export class InMemoryPiRuntimeFactory implements RemoteRuntimeFactory {
  private readonly cwdPromise: Promise<string>;
  private readonly agentDirPromise: Promise<string>;
  private readonly fauxRegistration: FauxProviderRegistration;
  private readonly fauxApiKey: string | null;

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
  }

  async create(): Promise<AgentSessionRuntime> {
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
