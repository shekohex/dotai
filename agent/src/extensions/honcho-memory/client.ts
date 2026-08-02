import { Honcho } from "@honcho-ai/sdk";
import type { Peer, Session } from "@honcho-ai/sdk";
import type { HonchoMemoryConfig } from "./config.js";

export interface HonchoMemoryContext {
  userProfile?: string | null;
  projectSummary?: string | null;
}

export interface HonchoSearchResult {
  id: string;
  peerId: string;
  content: string;
}

export interface HonchoMessageInput {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

export interface HonchoMemoryClient {
  readonly sessionKey: string;
  fetchContext(): Promise<HonchoMemoryContext>;
  search(query: string): Promise<HonchoSearchResult[]>;
  chat(query: string, reasoningLevel: string): Promise<string | null>;
  remember(content: string): Promise<string[]>;
  forget(conclusionId: string): Promise<void>;
  saveMessages(messages: HonchoMessageInput[]): Promise<void>;
}

export interface CreateHonchoMemoryClientInput {
  config: HonchoMemoryConfig;
  sessionKey: string;
}

class SdkHonchoMemoryClient implements HonchoMemoryClient {
  constructor(
    readonly sessionKey: string,
    private readonly config: HonchoMemoryConfig,
    private readonly userPeer: Peer,
    private readonly aiPeer: Peer,
    private readonly session: Session,
  ) {}

  async fetchContext(): Promise<HonchoMemoryContext> {
    const context = await this.session.context({
      summary: true,
      peerPerspective: this.aiPeer,
      peerTarget: this.userPeer,
      tokens: this.config.contextTokens,
    });
    return {
      userProfile: context.peerRepresentation,
      projectSummary: context.summary?.content,
    };
  }

  async search(query: string): Promise<HonchoSearchResult[]> {
    const messages = await this.session.search(query, { limit: this.config.searchLimit });
    return messages.map((message) => ({
      id: message.id,
      peerId: message.peerId,
      content: message.content,
    }));
  }

  chat(query: string, reasoningLevel: string): Promise<string | null> {
    return this.aiPeer.chat(query, {
      target: this.userPeer,
      session: this.session,
      reasoningLevel,
    });
  }

  async remember(content: string): Promise<string[]> {
    const conclusions = await this.aiPeer.conclusionsOf(this.userPeer).create({
      content,
      sessionId: this.session,
    });
    return conclusions.map((conclusion) => conclusion.id);
  }

  forget(conclusionId: string): Promise<void> {
    return this.aiPeer.conclusionsOf(this.userPeer).delete(conclusionId);
  }

  async saveMessages(messages: HonchoMessageInput[]): Promise<void> {
    await this.session.addMessages(
      messages.map((message) => {
        const peer = message.role === "user" ? this.userPeer : this.aiPeer;
        return peer.message(message.text, { createdAt: new Date(message.timestamp) });
      }),
    );
  }
}

export async function createHonchoMemoryClient(
  input: CreateHonchoMemoryClientInput,
): Promise<HonchoMemoryClient> {
  const honcho = new Honcho({
    apiKey: input.config.apiKey,
    baseURL: input.config.baseURL,
    workspaceId: input.config.workspaceId,
    timeout: input.config.timeoutMs,
    maxRetries: 1,
  });
  const [userPeer, aiPeer, session] = await Promise.all([
    honcho.peer(input.config.userPeerId),
    honcho.peer(input.config.aiPeerId),
    honcho.session(input.sessionKey),
  ]);
  await session.addPeers([userPeer, aiPeer]);
  return new SdkHonchoMemoryClient(input.sessionKey, input.config, userPeer, aiPeer, session);
}
