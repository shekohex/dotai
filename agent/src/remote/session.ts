/**
 * Session construction for remote mode. Builds an in-process AgentSession with the full bundled
 * extension set (mirrors the subagent-SDK LiteRuntime pattern).
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createHeadlessSession, createNoopUiContext } from "../headless/session.js";

export interface RemoteSessionHandle {
  readonly session: AgentSession;
  dispose(): void;
}

export interface CreateRemoteSessionOptions {
  cwd: string;
  agentDir: string;
}

export async function createRemoteSession(
  options: CreateRemoteSessionOptions,
): Promise<RemoteSessionHandle> {
  const handle = await createHeadlessSession(options);

  return {
    get session() {
      return handle.session;
    },
    dispose(): void {
      handle.dispose();
    },
  };
}

export { createNoopUiContext };
