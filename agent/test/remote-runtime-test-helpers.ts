import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryPiRuntimeFactory,
  type InMemoryPiRuntimeFactoryOptions,
} from "../src/remote/runtime-factory.ts";

interface CreateTempPersistedRuntimeHarnessOptions extends Omit<
  InMemoryPiRuntimeFactoryOptions,
  "agentDir" | "sessionDir" | "cwd" | "persistSessions"
> {
  prefix: string;
  cwd?: string;
}

export interface TempPersistedRuntimeHarness {
  root: string;
  agentDir: string;
  sessionDir: string;
  workspaceDir: string;
  runtimeFactory: ReturnType<typeof InMemoryPiRuntimeFactory>;
  cleanup: () => Promise<void>;
}

export async function createTempPersistedRuntimeHarness(
  options: CreateTempPersistedRuntimeHarnessOptions,
): Promise<TempPersistedRuntimeHarness> {
  const root = await mkdtemp(join(tmpdir(), options.prefix));
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const workspaceDir = options.cwd ?? join(root, "workspace");

  await mkdir(agentDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });

  return {
    root,
    agentDir,
    sessionDir,
    workspaceDir,
    runtimeFactory: InMemoryPiRuntimeFactory({
      ...options,
      cwd: workspaceDir,
      agentDir,
      sessionDir,
      persistSessions: true,
    }),
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}
