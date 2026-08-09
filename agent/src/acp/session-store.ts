import { unlink } from "node:fs/promises";
import { getAgentDir, SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import type {
  AcpCoreDependencies,
  AcpManagedSession,
  AcpSessionServices,
  AcpSessionEvent,
  AcpStoredSessionInfo,
} from "./core.js";
import { projectAgentSessionEvent } from "./events.js";
import { buildAcpCommandCatalog } from "./commands.js";
import { executeHeadlessBuiltin } from "./commands.js";
import { createHeadlessSession, type HeadlessSessionHandle } from "../headless/session.js";
import type { AcpPromptContent } from "./content.js";
import { createExtensionUiContext } from "./ui.js";
import { applyAcpConfigOption, buildAcpConfigOptions } from "./config.js";
import { createAcpMcpManager, type AcpMcpManager } from "./mcp.js";

export function createProductionAcpDependencies(): AcpCoreDependencies {
  return {
    createSession: (cwd, services) =>
      createManagedSession(cwd, SessionManager.create(cwd), services),
    openSession: async (sessionId, cwd, services) => {
      const info = await resolveSession(sessionId);
      if (info.cwd !== cwd) throw new Error(`ACP session ${sessionId} belongs to ${info.cwd}`);
      return createManagedSession(cwd, SessionManager.open(info.path), services);
    },
    forkSession: async (sessionId, cwd, services) => {
      const info = await resolveSession(sessionId);
      return createManagedSession(cwd, SessionManager.forkFrom(info.path, cwd), services);
    },
    listSessions: async (cwd) => {
      const sessions = await SessionManager.listAll();
      return sessions
        .filter((session) => cwd === undefined || session.cwd === cwd)
        .map((session) => toStoredInfo(session));
    },
    deleteSession: async (sessionId) => {
      const info = await resolveSession(sessionId, false);
      if (info !== undefined) await unlink(info.path);
    },
  };
}

async function createManagedSession(
  cwd: string,
  sessionManager: SessionManager,
  services?: AcpSessionServices,
): Promise<AcpManagedSession> {
  const ui = services?.createUi?.(sessionManager.getSessionId());
  const clientBridge = services?.createClientBridge?.(sessionManager.getSessionId());
  const clientToolOverrides = await clientBridge?.createToolOverrides(cwd);
  const mcp = await createAcpMcpManager(services?.mcpServers ?? [], cwd);
  try {
    const handle = await createHeadlessSession({
      cwd,
      agentDir: getAgentDir(),
      sessionManager,
      uiContext: ui === undefined ? undefined : createExtensionUiContext(ui),
      extraExtensionFactories: mcp.extensionFactories,
      coreUiToolOverrides: clientToolOverrides?.coreUi,
    });
    return new ProductionManagedSession(handle, mcp);
  } catch (error) {
    await mcp.dispose();
    throw error;
  }
}

class ProductionManagedSession implements AcpManagedSession {
  private readonly listeners = new Set<(event: AcpSessionEvent) => void>();
  private readonly unsubscribe: () => void;
  private settledGeneration = 0;

  constructor(
    private readonly handle: HeadlessSessionHandle,
    private readonly mcp: AcpMcpManager,
  ) {
    this.unsubscribe = handle.session.subscribe((event) => {
      const projected = projectAgentSessionEvent(handle.session, event);
      if (projected === undefined) return;
      if (projected.type === "settled") this.settledGeneration += 1;
      this.emit(projected);
    });
  }

  get id(): string {
    return this.handle.session.sessionId;
  }

  get cwd(): string {
    return this.handle.sessionManager.getCwd();
  }

  get availableCommands() {
    return buildAcpCommandCatalog(this.handle.session);
  }

  subscribe(listener: (event: AcpSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(content: AcpPromptContent): Promise<void> {
    const settledGeneration = this.settledGeneration;
    await this.handle.session.prompt(content.text, { images: content.images, source: "rpc" });
    await this.handle.session.waitForIdle();
    if (this.settledGeneration === settledGeneration) {
      this.settledGeneration += 1;
      this.emit({ type: "settled", stopReason: "end_turn" });
    }
  }

  deliver(content: AcpPromptContent, delivery: "followUp" | "steer"): Promise<void> {
    return this.handle.session.prompt(content.text, {
      images: content.images,
      source: "rpc",
      streamingBehavior: delivery,
    });
  }

  abort(): Promise<void> {
    return this.handle.session.abort();
  }

  waitForIdle(): Promise<void> {
    return this.handle.session.waitForIdle();
  }

  replay(): AcpSessionEvent[] {
    return this.handle.session.messages.flatMap((message) => {
      if (message.role === "user") {
        if (typeof message.content === "string") {
          return [{ type: "user_text" as const, text: message.content }];
        }
        const events: AcpSessionEvent[] = [];
        for (const content of message.content) {
          if (content.type === "text") events.push({ type: "user_text", text: content.text });
        }
        return events;
      }
      if (message.role === "assistant") {
        const events: AcpSessionEvent[] = [];
        for (const content of message.content) {
          if (content.type === "text") events.push({ type: "text", text: content.text });
          if (content.type === "thinking") {
            events.push({ type: "thought", text: content.thinking });
          }
        }
        return events;
      }
      return [];
    });
  }

  handleBuiltinCommand(prompt: string): Promise<string | undefined> {
    return executeHeadlessBuiltin(this.handle.session, prompt);
  }

  getConfigOptions() {
    return buildAcpConfigOptions(this.handle.session);
  }

  setConfigOption(configId: string, value: string | boolean): Promise<void> {
    return applyAcpConfigOption(this.handle.session, configId, value);
  }

  async dispose(): Promise<void> {
    this.unsubscribe();
    this.listeners.clear();
    await this.handle.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    this.handle.dispose();
    await this.mcp.dispose();
  }

  private emit(event: AcpSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

async function resolveSession(sessionId: string): Promise<SessionInfo>;
async function resolveSession(sessionId: string, required: false): Promise<SessionInfo | undefined>;
async function resolveSession(
  sessionId: string,
  required = true,
): Promise<SessionInfo | undefined> {
  const matches = (await SessionManager.listAll()).filter((session) => session.id === sessionId);
  if (matches.length === 0) {
    if (!required) return undefined;
    throw new Error(`ACP session not found: ${sessionId}`);
  }
  if (matches.length > 1) throw new Error(`ACP session ID is not unique: ${sessionId}`);
  return matches[0];
}

function toStoredInfo(session: SessionInfo): AcpStoredSessionInfo {
  return {
    sessionId: session.id,
    cwd: session.cwd,
    title: session.name ?? (session.firstMessage || undefined),
    updatedAt: session.modified.toISOString(),
  };
}
