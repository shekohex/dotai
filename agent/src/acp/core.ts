import type { AcpPromptContent } from "./content.js";
export type { AcpPromptContent } from "./content.js";
import type { AcpUi } from "./ui.js";
import type { AcpMcpServer } from "./mcp.js";
import type { AcpClientBridge } from "./client-bridge.js";

export type AcpSessionEvent =
  | { type: "user_text"; text: string; messageId?: string }
  | { type: "text"; text: string; messageId?: string }
  | { type: "thought"; text: string; messageId?: string }
  | {
      type: "tool_start";
      toolCallId: string;
      name: string;
      title: string;
      kind: AcpToolKind;
      rawInput: unknown;
      locations?: AcpToolLocation[];
    }
  | {
      type: "tool_update";
      toolCallId: string;
      name: string;
      content?: AcpToolContent[];
      rawOutput?: unknown;
    }
  | {
      type: "tool_end";
      toolCallId: string;
      name: string;
      status: "completed" | "failed";
      content?: AcpToolContent[];
      rawOutput?: unknown;
    }
  | { type: "settled"; stopReason: AcpStopReason };

export type AcpToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export type AcpToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface AcpToolLocation {
  path: string;
  line?: number;
}

export type AcpStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

export interface AcpManagedSession {
  readonly id: string;
  readonly cwd: string;
  readonly availableCommands: AcpAvailableCommand[];
  subscribe(listener: (event: AcpSessionEvent) => void): () => void;
  prompt(content: AcpPromptContent): Promise<void>;
  deliver?(content: AcpPromptContent, delivery: "followUp" | "steer"): Promise<void>;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  replay(): AcpSessionEvent[];
  handleBuiltinCommand(prompt: string): Promise<string | undefined>;
  getConfigOptions?(): Promise<AcpConfigOption[]>;
  setConfigOption?(configId: string, value: string | boolean): Promise<void>;
  dispose(): void | Promise<void>;
}

export interface AcpAvailableCommand {
  name: string;
  description: string;
  inputHint?: string;
}

export interface AcpConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: "select";
  currentValue: string;
  options: Array<{ value: string; name: string; description?: string }>;
}

export interface AcpStoredSessionInfo {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
}

export interface AcpCoreDependencies {
  createSession(cwd: string, services?: AcpSessionServices): Promise<AcpManagedSession>;
  openSession(
    sessionId: string,
    cwd: string,
    services?: AcpSessionServices,
  ): Promise<AcpManagedSession>;
  forkSession(
    sessionId: string,
    cwd: string,
    services?: AcpSessionServices,
  ): Promise<AcpManagedSession>;
  listSessions(cwd?: string): Promise<AcpStoredSessionInfo[]>;
  deleteSession(sessionId: string): Promise<void>;
}

export interface AcpSessionServices {
  createUi?: (sessionId: string) => AcpUi;
  mcpServers?: AcpMcpServer[];
  createClientBridge?: (sessionId: string) => AcpClientBridge;
}

interface ManagedRecord {
  session: AcpManagedSession;
  mutation: Promise<void>;
  activePrompt?: Promise<void>;
}

export class AcpAgentCore {
  private readonly records = new Map<string, ManagedRecord>();

  constructor(private readonly dependencies: AcpCoreDependencies) {}

  async createSession(cwd: string, services?: AcpSessionServices): Promise<AcpManagedSession> {
    const session = await this.dependencies.createSession(cwd, services);
    this.add(session);
    return session;
  }

  async openSession(
    sessionId: string,
    cwd: string,
    services?: AcpSessionServices,
  ): Promise<AcpManagedSession> {
    const existing = this.records.get(sessionId)?.session;
    if (existing !== undefined) return existing;
    const session = await this.dependencies.openSession(sessionId, cwd, services);
    this.add(session);
    return session;
  }

  async forkSession(
    sessionId: string,
    cwd: string,
    services?: AcpSessionServices,
  ): Promise<AcpManagedSession> {
    const session = await this.dependencies.forkSession(sessionId, cwd, services);
    this.add(session);
    return session;
  }

  async loadSession(
    sessionId: string,
    cwd: string,
    emit: (event: AcpSessionEvent) => Promise<void>,
    services?: AcpSessionServices,
  ): Promise<AcpManagedSession> {
    const session = await this.openSession(sessionId, cwd, services);
    for (const event of session.replay()) await emit(event);
    return session;
  }

  listSessions(cwd?: string): Promise<AcpStoredSessionInfo[]> {
    return this.dependencies.listSessions(cwd);
  }

  getSession(sessionId: string): AcpManagedSession {
    return this.requireRecord(sessionId).session;
  }

  async getConfigOptions(sessionId: string): Promise<AcpConfigOption[]> {
    return (await this.getSession(sessionId).getConfigOptions?.()) ?? [];
  }

  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string | boolean,
  ): Promise<AcpConfigOption[]> {
    const session = this.getSession(sessionId);
    if (session.setConfigOption === undefined)
      throw new Error(`Unknown ACP config option: ${configId}`);
    const currentOptions = (await session.getConfigOptions?.()) ?? [];
    const option = currentOptions.find((candidate) => candidate.id === configId);
    if (option === undefined) throw new Error(`Unknown ACP config option: ${configId}`);
    if (
      typeof value !== "string" ||
      !option.options.some((candidate) => candidate.value === value)
    ) {
      throw new Error(`Unknown value for ACP config ${configId}: ${String(value)}`);
    }
    await session.setConfigOption(configId, value);
    return (await session.getConfigOptions?.()) ?? [];
  }

  async prompt(
    sessionId: string,
    content: AcpPromptContent,
    emit: (event: AcpSessionEvent) => Promise<void>,
  ): Promise<AcpStopReason> {
    const record = this.requireRecord(sessionId);
    if (record.activePrompt !== undefined) {
      await record.session.abort();
      await boundedWait(record.activePrompt);
    }
    const operation = this.queue(record, async () => {
      const text = content.text;
      const builtinResult = await record.session.handleBuiltinCommand(text);
      if (builtinResult !== undefined) {
        if (builtinResult.length > 0) {
          await emit({ type: "text", text: builtinResult, messageId: `command:${sessionId}` });
        }
        return "end_turn" as const;
      }
      let stopReason: AcpStopReason = "end_turn";
      let settle: (() => void) | undefined;
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      let outbound = Promise.resolve();
      const unsubscribe = record.session.subscribe((event) => {
        if (event.type === "settled") {
          stopReason = event.stopReason;
          settle?.();
          return;
        }
        outbound = outbound.then(() => emit(event));
      });
      const prompt = record.session
        .prompt(content)
        .then(() => settled)
        .finally(() => {
          unsubscribe();
        });
      record.activePrompt = prompt;
      try {
        await prompt;
        await outbound;
        return stopReason;
      } finally {
        if (record.activePrompt === prompt) record.activePrompt = undefined;
      }
    });
    return operation;
  }

  async cancel(sessionId: string): Promise<void> {
    const record = this.requireRecord(sessionId);
    await record.session.abort();
    await record.session.waitForIdle();
  }

  async deliver(
    sessionId: string,
    content: AcpPromptContent,
    delivery: "followUp" | "steer",
  ): Promise<void> {
    const session = this.getSession(sessionId);
    if (session.deliver === undefined)
      throw new Error("ACP session does not support queued prompts");
    await session.deliver(content, delivery);
  }

  async close(sessionId: string): Promise<void> {
    const record = this.records.get(sessionId);
    if (record === undefined) return;
    await record.session.abort();
    await record.session.waitForIdle();
    await record.session.dispose();
    this.records.delete(sessionId);
  }

  async delete(sessionId: string): Promise<void> {
    await this.close(sessionId);
    await this.dependencies.deleteSession(sessionId);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.records.keys()].map((sessionId) => this.close(sessionId)));
  }

  private add(session: AcpManagedSession): void {
    if (this.records.has(session.id)) {
      void session.dispose();
      throw new Error(`ACP session already active: ${session.id}`);
    }
    this.records.set(session.id, { session, mutation: Promise.resolve() });
  }

  private requireRecord(sessionId: string): ManagedRecord {
    const record = this.records.get(sessionId);
    if (record === undefined) throw new Error(`ACP session not active: ${sessionId}`);
    return record;
  }

  private queue<T>(record: ManagedRecord, operation: () => Promise<T>): Promise<T> {
    const result = record.mutation.then(operation, operation);
    record.mutation = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}

async function boundedWait(promise: Promise<void>, timeoutMs = 5_000): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
