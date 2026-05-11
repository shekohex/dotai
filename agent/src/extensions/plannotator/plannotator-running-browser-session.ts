import { Type } from "typebox";
import { Value } from "typebox/value";

import { resolveBrowserAccessUrl } from "../../utils/browser-launch.js";
import { getServerPort } from "./server/network.js";

const RunningReviewServerSchema = Type.Object({
  agentCwd: Type.Optional(Type.String()),
  gitContext: Type.Optional(
    Type.Object({
      cwd: Type.Optional(Type.String()),
    }),
  ),
});

const RunningAnnotationServerSchema = Type.Object({
  filePath: Type.Optional(Type.String()),
  mode: Type.Optional(Type.String()),
  projectRoot: Type.Optional(Type.String()),
});

function normalizeWorkspacePath(filePath: string): string {
  return filePath;
}

export async function canReconnectToRunningReviewServerForCwd(cwd: string): Promise<string | null> {
  const { port } = getServerPort();
  if (port <= 0) {
    return null;
  }

  const localhostUrl = `http://127.0.0.1:${port}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, 1000);

  try {
    const response = await fetch(`${localhostUrl}/api/diff`, {
      method: "GET",
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const payload: unknown = await response.json();
    if (!Value.Check(RunningReviewServerSchema, payload)) {
      return null;
    }
    const expectedCwd = normalizeWorkspacePath(cwd);
    let serverCwd: string | null = null;
    if (typeof payload.agentCwd === "string") {
      serverCwd = payload.agentCwd;
    } else if (typeof payload.gitContext?.cwd === "string") {
      serverCwd = payload.gitContext.cwd;
    }
    if (serverCwd === null || normalizeWorkspacePath(serverCwd) !== expectedCwd) {
      return null;
    }
    return resolveBrowserAccessUrl({ serverUrl: localhostUrl, port });
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function canReconnectToRunningAnnotationServer(args: {
  cwd: string;
  filePath: string;
  mode: "annotate" | "annotate-folder" | "annotate-last";
}): Promise<string | null> {
  const { port } = getServerPort();
  if (port <= 0) {
    return null;
  }

  const localhostUrl = `http://127.0.0.1:${port}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, 1000);

  try {
    const response = await fetch(`${localhostUrl}/api/plan`, {
      method: "GET",
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const payload: unknown = await response.json();
    if (!Value.Check(RunningAnnotationServerSchema, payload)) {
      return null;
    }
    const expectedCwd = normalizeWorkspacePath(args.cwd);
    const serverProjectRoot = payload.projectRoot;
    if (
      typeof serverProjectRoot !== "string" ||
      normalizeWorkspacePath(serverProjectRoot) !== expectedCwd
    ) {
      return null;
    }
    if (payload.filePath !== args.filePath || payload.mode !== args.mode) {
      return null;
    }
    return resolveBrowserAccessUrl({ serverUrl: localhostUrl, port });
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
