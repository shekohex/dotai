import { execFileSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import {
  isRunningInCoderWorkspace,
  resolveCoderPublicBaseUrl,
} from "../../utils/browser-access.js";
import type { TmuxSessionInfo } from "./terminal.js";

export interface ShareState {
  port: number;
  sessionInfo: TmuxSessionInfo;
  startedAt: number;
  connectionCount: number;
  localUrl: string;
  lanUrl: string;
  tailscaleUrl: string | null;
  coderPublicUrl: string | null;
}

let activeState: ShareState | null = null;

export function setShareState(state: ShareState): void {
  activeState = state;
}

export function getShareState(): ShareState | null {
  return activeState;
}

export function clearShareState(): void {
  activeState = null;
}

export function incrementConnectionCount(): void {
  if (activeState) {
    activeState.connectionCount += 1;
  }
}

export function decrementConnectionCount(): void {
  if (activeState) {
    activeState.connectionCount = Math.max(0, activeState.connectionCount - 1);
  }
}

function getLanIp(): string {
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces).toSorted()) {
    if (
      name.startsWith("lo") ||
      name.startsWith("docker") ||
      name.startsWith("br-") ||
      name.startsWith("veth")
    ) {
      continue;
    }
    const net = interfaces[name];
    if (!net) continue;
    for (const addr of net) {
      if (addr.family === "IPv4" && !addr.internal) {
        return addr.address;
      }
    }
  }
  return "127.0.0.1";
}

function getTailscaleIp(): string | null {
  try {
    const output = execFileSync("tailscale", ["ip", "-4"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

export function buildShareUrls(
  port: number,
  environment: NodeJS.ProcessEnv = process.env,
): Pick<ShareState, "localUrl" | "lanUrl" | "tailscaleUrl" | "coderPublicUrl"> {
  const lanIp = getLanIp();
  return {
    localUrl: `http://127.0.0.1:${port}`,
    lanUrl: `http://${lanIp}:${port}`,
    tailscaleUrl: (() => {
      const ip = getTailscaleIp();
      if (ip !== null && ip.length > 0) {
        return `http://${ip}:${port}`;
      }
      return null;
    })(),
    coderPublicUrl: (() => {
      if (!isRunningInCoderWorkspace(environment)) {
        return null;
      }
      return resolveCoderPublicBaseUrl(port, environment);
    })(),
  };
}

export function formatStatusMessage(state: ShareState): string {
  const lines = [
    `Tmux Share active on port ${state.port}`,
    `Session: ${state.sessionInfo.sessionName}`,
    `Window: ${state.sessionInfo.windowId}`,
    `Connected viewers: ${state.connectionCount}`,
    "",
    "Share URLs:",
    `  Local:    ${state.localUrl}`,
    `  LAN:      ${state.lanUrl}`,
  ];

  if (state.tailscaleUrl !== null && state.tailscaleUrl.length > 0) {
    lines.push(`  Tailscale: ${state.tailscaleUrl}`);
  }

  if (state.coderPublicUrl !== null && state.coderPublicUrl.length > 0) {
    lines.push(`  Coder:    ${state.coderPublicUrl}`);
  }

  return lines.join("\n");
}
