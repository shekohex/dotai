import type {
  CreatePaneOptions,
  CreatedPane,
  MuxAdapter,
  PaneCapture,
  PaneSubmitMode,
} from "./mux.js";

type AdapterFailure = {
  backend: string;
  message: string;
};

function formatFailure(failure: AdapterFailure): string {
  return `${failure.backend}: ${failure.message}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class FallbackMuxAdapter implements MuxAdapter {
  readonly backend: string;
  private readonly adaptersByBackend: Map<string, MuxAdapter>;
  private readonly paneBackends = new Map<string, string>();

  constructor(private readonly adapters: MuxAdapter[]) {
    this.backend = adapters.map((adapter) => adapter.backend).join("+") || "fallback";
    this.adaptersByBackend = new Map(adapters.map((adapter) => [adapter.backend, adapter]));
  }

  async isAvailable(): Promise<boolean> {
    for (const adapter of this.adapters) {
      if (await adapter.isAvailable().catch(() => false)) {
        return true;
      }
    }
    return false;
  }

  async createPane(options: CreatePaneOptions): Promise<CreatedPane> {
    const failures: AdapterFailure[] = [];
    for (const adapter of this.adapters) {
      const available = await adapter.isAvailable().catch((error) => {
        failures.push({ backend: adapter.backend, message: errorMessage(error) });
        return false;
      });
      if (!available) {
        failures.push({ backend: adapter.backend, message: "not available" });
        continue;
      }
      try {
        const pane = await adapter.createPane(options);
        const backend = pane.backend ?? adapter.backend;
        this.paneBackends.set(pane.paneId, backend);
        return { ...pane, backend };
      } catch (error) {
        failures.push({ backend: adapter.backend, message: errorMessage(error) });
      }
    }

    throw new Error(
      `No mux adapter could create pane: ${failures.map((failure) => formatFailure(failure)).join("; ")}`,
    );
  }

  sendText(
    paneId: string,
    text: string,
    submitMode?: PaneSubmitMode,
    backend?: string,
  ): Promise<void> {
    return this.resolveAdapter(paneId, backend).sendText(paneId, text, submitMode);
  }

  paneExists(paneId: string, backend?: string): Promise<boolean> {
    return this.resolveAdapter(paneId, backend).paneExists(paneId);
  }

  killPane(paneId: string, backend?: string): Promise<void> {
    return this.resolveAdapter(paneId, backend).killPane(paneId);
  }

  capturePane(paneId: string, lines?: number, backend?: string): Promise<PaneCapture> {
    return this.resolveAdapter(paneId, backend).capturePane(paneId, lines);
  }

  dispose(): void {
    for (const adapter of this.adapters) {
      adapter.dispose?.();
    }
    this.paneBackends.clear();
  }

  private resolveAdapter(paneId: string, backend?: string): MuxAdapter {
    const resolvedBackend = backend ?? this.paneBackends.get(paneId) ?? this.inferBackend(paneId);
    if (resolvedBackend !== undefined) {
      const adapter = this.adaptersByBackend.get(resolvedBackend);
      if (adapter !== undefined) {
        return adapter;
      }
    }

    const [defaultAdapter] = this.adapters;
    if (defaultAdapter !== undefined) {
      return defaultAdapter;
    }

    const suffix = backend !== undefined && backend.length > 0 ? ` on ${backend}` : "";
    throw new Error(`No mux adapter found for pane ${paneId}${suffix}`);
  }

  private inferBackend(paneId: string): string | undefined {
    if (paneId.startsWith("pty:")) {
      return "pty";
    }
    if (paneId.startsWith("%")) {
      return "tmux";
    }
    return undefined;
  }
}
