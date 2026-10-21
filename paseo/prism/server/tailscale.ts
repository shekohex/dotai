import { execFile } from "node:child_process";

const COMMANDS = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
const COMMAND_TIMEOUT_MS = 10_000;
const HTTPS_PORTS = [8443, 10000, 8444, 8445, 8446];
/** Marks the mapping as Prism's, so it can be found and removed without touching the user's own serves. */
const MOUNT_PATH = "/prism-media";

export interface TailscaleShare {
  /** The tailnet HTTPS origin that reaches the local port, such as https://host.tailnet.ts.net:8443. */
  origin: string;
  stop(): Promise<void>;
}

function run(command: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) =>
      resolve(error ? null : stdout),
    );
  });
}

async function findTailscale(): Promise<{ command: string; dnsName: string } | null> {
  for (const command of COMMANDS) {
    const output = await run(command, ["status", "--json"]);
    if (output === null) continue;
    try {
      const status = JSON.parse(output) as { BackendState?: string; Self?: { DNSName?: string } };
      const dnsName = status.Self?.DNSName?.replace(/\.$/, "");
      if (status.BackendState === "Running" && dnsName) return { command, dnsName };
    } catch {
      // Not JSON: not a usable tailscale.
    }
  }
  return null;
}

async function usedHttpsPorts(command: string): Promise<Set<number>> {
  const output = await run(command, ["serve", "status", "--json"]);
  try {
    const config = JSON.parse(output ?? "{}") as { TCP?: Record<string, unknown> };
    return new Set(Object.keys(config.TCP ?? {}).map(Number));
  } catch {
    return new Set();
  }
}

/**
 * Publishes a loopback port to the tailnet over HTTPS with `tailscale serve`, so clients on other machines
 * can reach it. Returns null when Tailscale is missing, stopped, or has HTTPS/Serve disabled.
 */
export async function shareOverTailscale(localPort: number): Promise<TailscaleShare | null> {
  const tailscale = await findTailscale();
  if (!tailscale) return null;
  const { command, dnsName } = tailscale;
  const used = await usedHttpsPorts(command);
  const port = HTTPS_PORTS.find((candidate) => !used.has(candidate));
  if (port === undefined) return null;
  const mount = [`--https=${port}`, `--set-path=${MOUNT_PATH}`];
  const started = await run(command, ["serve", "--bg", ...mount, `http://127.0.0.1:${localPort}`]);
  if (started === null) return null;
  return {
    origin: `https://${dnsName}:${port}${MOUNT_PATH}`,
    stop: async () => void (await run(command, ["serve", ...mount, "off"])),
  };
}
