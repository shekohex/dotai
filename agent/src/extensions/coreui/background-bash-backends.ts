import type { BackgroundBackendName, BackgroundShellBackend } from "./background-bash-backend.js";
import { HerdrBackgroundShellBackend } from "./background-bash-herdr-backend.js";
import { PtyBackgroundShellBackend } from "./background-bash-pty-backend.js";
import { TmuxBackgroundShellBackend } from "./background-bash-tmux-backend.js";

const backends: BackgroundShellBackend[] = [
  new HerdrBackgroundShellBackend(),
  new TmuxBackgroundShellBackend(),
  new PtyBackgroundShellBackend(),
];

const backendsByName = new Map(backends.map((backend) => [backend.name, backend]));

export async function selectBackgroundShellBackend(cwd: string): Promise<BackgroundShellBackend> {
  for (const backend of backends) {
    if (await backend.isAvailable(cwd)) return backend;
  }
  return getBackgroundShellBackend("pty");
}

export function getBackgroundShellBackend(name: BackgroundBackendName): BackgroundShellBackend {
  const backend = backendsByName.get(name);
  if (backend === undefined) throw new Error(`Unknown background shell backend: ${name}`);
  return backend;
}

export function warmBackgroundShellBackendAvailability(): void {
  for (const backend of backends) {
    void backend.isAvailable(process.cwd()).catch(() => false);
  }
}
