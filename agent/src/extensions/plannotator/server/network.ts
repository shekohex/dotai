/** Network utilities — remote detection and port binding. */

import type { Server } from "node:http";
import { isSshSession } from "../../../utils/browser-access.js";

const DEFAULT_REMOTE_PORT = 19432;
const LOOPBACK_HOST = "127.0.0.1";

/**
 * Check if running in a remote session (SSH, devcontainer, etc.) Honors PLANNOTATOR_REMOTE as a
 * tri-state override, or detects SSH_TTY/SSH_CONNECTION.
 *
 * @returns {boolean | null} Remote override value when configured.
 */
function getRemoteOverride(): boolean | null {
  const remote = process.env.PLANNOTATOR_REMOTE;
  if (remote === undefined) {
    return null;
  }

  if (remote === "1" || remote.toLowerCase() === "true") {
    return true;
  }

  if (remote === "0" || remote.toLowerCase() === "false") {
    return false;
  }

  return null;
}

export function isRemoteSession(): boolean {
  const remoteOverride = getRemoteOverride();
  if (remoteOverride !== null) {
    return remoteOverride;
  }
  return isSshSession();
}

/**
 * Get the server port to use.
 *
 * - PLANNOTATOR_PORT env var takes precedence
 * - Remote sessions default to 19432 (for port forwarding)
 * - Local sessions use random port Returns { port, portSource } so caller can notify user if needed.
 *
 * @returns {{ port: number; portSource: "env" | "remote-default" | "random" }} Port choice and
 *   source.
 */
export function getServerPort(): {
  port: number;
  portSource: "env" | "remote-default" | "random";
} {
  const envPort = process.env.PLANNOTATOR_PORT;
  if (envPort !== undefined && envPort.length > 0) {
    const parsed = parseInt(envPort, 10);
    if (!Number.isNaN(parsed) && parsed > 0 && parsed < 65536) {
      return { port: parsed, portSource: "env" };
    }
    // Invalid port - fall back silently, caller can check env var themselves
  }
  if (isRemoteSession()) {
    return { port: DEFAULT_REMOTE_PORT, portSource: "remote-default" };
  }
  return { port: 0, portSource: "random" };
}

export function getServerHostname(): string {
  return isRemoteSession() ? "0.0.0.0" : LOOPBACK_HOST;
}

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 500;

export async function listenOnPort(
  server: Server,
): Promise<{ port: number; portSource: "env" | "remote-default" | "random" }> {
  const result = getServerPort();

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(result.port, getServerHostname(), () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        throw new Error("Failed to resolve listening port");
      }
      return { port: addr.port, portSource: result.portSource };
    } catch (err: unknown) {
      const isAddressInUse = err instanceof Error && err.message.includes("EADDRINUSE");
      if (isAddressInUse && attempt < MAX_RETRIES) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, RETRY_DELAY_MS);
        });
        continue;
      }
      if (isAddressInUse) {
        const hint = isRemoteSession() ? " (set PLANNOTATOR_PORT to use a different port)" : "";
        throw new Error(`Port ${result.port} in use after ${MAX_RETRIES} retries${hint}`, {
          cause: err,
        });
      }
      throw err;
    }
  }

  // Unreachable, but satisfies TypeScript
  throw new Error("Failed to bind port");
}
