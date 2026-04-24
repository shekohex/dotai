import {
  InteractiveMode,
  initTheme,
  type AgentSessionRuntime,
  type ExtensionFactory,
} from "@mariozechner/pi-coding-agent";
import {
  RemoteAgentSessionRuntime,
  defaultSessionNameFromCwd,
  readRemotePrivateKey,
} from "./client-runtime.js";
import type { AppSnapshot, ClientCapabilities, RemoteExtensionMetadata } from "./schemas.js";
import { RemoteApiClient } from "./remote-api-client.js";

function isInteractiveRuntimeContract(value: unknown): value is AgentSessionRuntime {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const runtime = value as Partial<AgentSessionRuntime> & {
    session?: {
      prompt?: unknown;
      sendUserMessage?: unknown;
      setModel?: unknown;
      reload?: unknown;
    };
  };
  const session = runtime.session;
  if (session === null || typeof session !== "object" || Array.isArray(session)) {
    return false;
  }

  return (
    typeof runtime.newSession === "function" &&
    typeof runtime.switchSession === "function" &&
    typeof runtime.fork === "function" &&
    typeof runtime.importFromJsonl === "function" &&
    typeof runtime.dispose === "function" &&
    typeof session.prompt === "function" &&
    typeof session.sendUserMessage === "function" &&
    typeof session.setModel === "function" &&
    typeof session.reload === "function"
  );
}

interface ParsedRemoteArgs {
  remoteOrigin: string;
  keyId: string;
  privateKey?: string;
  privateKeyPath?: string;
  sessionId?: string;
  resume: boolean;
  continueSession: boolean;
  forkSessionId?: string;
  noSession: boolean;
  exportPath?: string;
  sessionDir?: string;
  sessionName?: string;
  workspaceCwd?: string;
  verbose: boolean;
  initialMessage?: string;
  initialMessages: string[];
}

type RemoteFlagSetter = (parsed: ParsedRemoteArgs, value: string) => void;

const remoteFlagSetters = new Map<string, RemoteFlagSetter>([
  [
    "--remote",
    (parsed, value) => {
      parsed.remoteOrigin = value;
    },
  ],
  [
    "--remote-origin",
    (parsed, value) => {
      parsed.remoteOrigin = value;
    },
  ],
  [
    "--remote-key-id",
    (parsed, value) => {
      parsed.keyId = value;
    },
  ],
  [
    "--remote-private-key",
    (parsed, value) => {
      parsed.privateKey = value;
    },
  ],
  [
    "--remote-private-key-path",
    (parsed, value) => {
      parsed.privateKeyPath = value;
    },
  ],
  [
    "--remote-session",
    (parsed, value) => {
      parsed.sessionId = value;
    },
  ],
  [
    "--session",
    (parsed, value) => {
      parsed.sessionId = value;
    },
  ],
  [
    "--remote-session-name",
    (parsed, value) => {
      parsed.sessionName = value;
    },
  ],
  [
    "--workspace-cwd",
    (parsed, value) => {
      parsed.workspaceCwd = value;
    },
  ],
  [
    "--fork",
    (parsed, value) => {
      parsed.forkSessionId = value;
    },
  ],
  [
    "--session-dir",
    (parsed, value) => {
      parsed.sessionDir = value;
    },
  ],
  [
    "--export",
    (parsed, value) => {
      parsed.exportPath = value;
    },
  ],
  [
    "-p",
    (parsed, value) => {
      parsed.initialMessage = value;
    },
  ],
  [
    "--prompt",
    (parsed, value) => {
      parsed.initialMessage = value;
    },
  ],
]);

function consumeFlagValue(args: string[], index: number): { value?: string; nextIndex: number } {
  const value = args[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("-")) {
    return { nextIndex: index };
  }
  return { value, nextIndex: index + 1 };
}

function applyRemoteFlag(
  parsed: ParsedRemoteArgs,
  args: string[],
  index: number,
): { consumed: boolean; nextIndex: number } {
  const arg = args[index];
  if (arg === "--verbose") {
    parsed.verbose = true;
    return { consumed: true, nextIndex: index };
  }
  if (arg === "--resume") {
    parsed.resume = true;
    return { consumed: true, nextIndex: index };
  }
  if (arg === "--continue") {
    parsed.continueSession = true;
    return { consumed: true, nextIndex: index };
  }
  if (arg === "--no-session") {
    parsed.noSession = true;
    return { consumed: true, nextIndex: index };
  }

  const setter = remoteFlagSetters.get(arg);
  if (!setter) {
    return { consumed: false, nextIndex: index };
  }

  const consumed = consumeFlagValue(args, index);
  if (consumed.value !== undefined) {
    setter(parsed, consumed.value);
  }
  return { consumed: true, nextIndex: consumed.nextIndex };
}

export function shouldUseRemoteMode(args: string[]): boolean {
  if (process.env.PI_REMOTE_ORIGIN !== undefined && process.env.PI_REMOTE_ORIGIN.length > 0) {
    return true;
  }
  return args.includes("--remote") || args.includes("--remote-origin");
}

function readSelectedSessionModeCount(parsed: ParsedRemoteArgs): number {
  return [
    parsed.sessionId !== undefined,
    parsed.resume,
    parsed.continueSession,
    parsed.forkSessionId !== undefined,
    parsed.noSession,
  ].filter(Boolean).length;
}

export function parseRemoteArgs(args: string[]): ParsedRemoteArgs {
  const parsed: ParsedRemoteArgs = {
    remoteOrigin: process.env.PI_REMOTE_ORIGIN ?? "",
    keyId: process.env.PI_REMOTE_KEY_ID ?? "",
    privateKey: process.env.PI_REMOTE_PRIVATE_KEY,
    privateKeyPath: process.env.PI_REMOTE_PRIVATE_KEY_PATH,
    sessionId: process.env.PI_REMOTE_SESSION_ID,
    resume: false,
    continueSession: false,
    forkSessionId: undefined,
    noSession: false,
    exportPath: undefined,
    sessionDir: undefined,
    sessionName: process.env.PI_REMOTE_SESSION_NAME,
    workspaceCwd: process.env.PI_REMOTE_WORKSPACE_CWD,
    verbose: false,
    initialMessage: undefined,
    initialMessages: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.length === 0) {
      continue;
    }
    const appliedFlag = applyRemoteFlag(parsed, args, index);
    if (appliedFlag.consumed) {
      index = appliedFlag.nextIndex;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    parsed.initialMessages.push(arg);
  }

  if (parsed.remoteOrigin.length === 0) {
    throw new Error("Missing PI_REMOTE_ORIGIN or --remote-origin");
  }
  if (parsed.keyId.length === 0) {
    throw new Error("Missing PI_REMOTE_KEY_ID or --remote-key-id");
  }
  if (parsed.sessionDir !== undefined) {
    throw new Error("Remote mode does not support --session-dir");
  }
  if (parsed.exportPath !== undefined) {
    throw new Error("Remote mode does not support --export yet");
  }
  if (parsed.forkSessionId !== undefined) {
    throw new Error("Remote mode does not support --fork yet");
  }
  if (readSelectedSessionModeCount(parsed) > 1) {
    throw new Error(
      "Remote mode session selection flags are mutually exclusive: use one of --session, --resume, --continue, --fork, or --no-session",
    );
  }

  return parsed;
}

function findMatchingRemoteSessions(snapshot: AppSnapshot, query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return [];
  }
  return snapshot.sessionSummaries.filter((summary) => {
    const sessionId = summary.sessionId.toLowerCase();
    const sessionName = summary.sessionName.toLowerCase();
    const cwd = summary.cwd.toLowerCase();
    return (
      sessionId === normalizedQuery ||
      sessionName === normalizedQuery ||
      sessionId.includes(normalizedQuery) ||
      sessionName.includes(normalizedQuery) ||
      cwd.includes(normalizedQuery)
    );
  });
}

export function resolveRemoteSessionId(input: {
  snapshot: AppSnapshot;
  parsed: ParsedRemoteArgs;
  cwd?: string;
}): { sessionId?: string; createNewSession: boolean } {
  const workspaceCwd = input.parsed.workspaceCwd ?? input.cwd;
  if (input.parsed.noSession) {
    if (workspaceCwd === undefined || workspaceCwd.length === 0) {
      throw new Error("Remote new session requires --workspace-cwd");
    }
    return { createNewSession: true };
  }

  if (input.parsed.sessionId !== undefined) {
    const matches = findMatchingRemoteSessions(input.snapshot, input.parsed.sessionId);
    if (matches.length === 0) {
      throw new Error(`Remote session not found: ${input.parsed.sessionId}`);
    }
    if (matches.length > 1) {
      const labels = matches.map((summary) => `${summary.sessionId} (${summary.sessionName})`);
      throw new Error(
        `Remote session query is ambiguous: ${input.parsed.sessionId}. Matches: ${labels.join(", ")}`,
      );
    }
    const selectedMatch = matches[0];
    if (selectedMatch === undefined) {
      throw new Error(`Remote session not found: ${input.parsed.sessionId}`);
    }
    return { sessionId: selectedMatch.sessionId, createNewSession: false };
  }

  if (input.parsed.resume) {
    const defaultSessionId = input.snapshot.defaultAttachSessionId;
    if (defaultSessionId !== undefined) {
      return { sessionId: defaultSessionId, createNewSession: false };
    }
    const latest = input.snapshot.sessionSummaries.toSorted(
      (left, right) => right.updatedAt - left.updatedAt,
    )[0];
    if (latest !== undefined) {
      return { sessionId: latest.sessionId, createNewSession: false };
    }
    return { createNewSession: true };
  }

  if (input.parsed.continueSession) {
    if (workspaceCwd === undefined || workspaceCwd.length === 0) {
      throw new Error("Remote --continue requires --workspace-cwd");
    }
    const workspaceMatches = input.snapshot.sessionSummaries
      .filter((summary) => summary.cwd === workspaceCwd)
      .toSorted((left, right) => right.updatedAt - left.updatedAt);
    const latestWorkspaceSession = workspaceMatches[0];
    if (latestWorkspaceSession !== undefined) {
      return { sessionId: latestWorkspaceSession.sessionId, createNewSession: false };
    }
    return { createNewSession: true };
  }

  return { sessionId: input.parsed.sessionId, createNewSession: false };
}

export interface RunRemoteInteractiveModeOptions {
  clientExtensionMetadata?: RemoteExtensionMetadata[];
  clientExtensionFactories?: ExtensionFactory[];
  clientCapabilities?: ClientCapabilities;
}

export async function runRemoteInteractiveMode(
  args: string[],
  options: RunRemoteInteractiveModeOptions = {},
): Promise<void> {
  const parsed = parseRemoteArgs(args);
  const privateKey = await readRemotePrivateKey({
    privateKey: parsed.privateKey,
    privateKeyPath: parsed.privateKeyPath,
  });

  const client = new RemoteApiClient({
    origin: parsed.remoteOrigin,
    auth: {
      keyId: parsed.keyId,
      privateKey,
    },
    clientCapabilities: options.clientCapabilities,
  });

  await client.authenticate();
  const appSnapshot = await client.getAppSnapshot();
  const selection = resolveRemoteSessionId({
    snapshot: appSnapshot,
    parsed,
    cwd: undefined,
  });

  const runtimeCandidate: unknown = await RemoteAgentSessionRuntime.create({
    origin: parsed.remoteOrigin,
    auth: {
      keyId: parsed.keyId,
      privateKey,
    },
    sessionId: selection.sessionId,
    sessionName: parsed.sessionName ?? defaultSessionNameFromCwd(process.cwd()),
    createNewSession: selection.createNewSession,
    workspaceCwd: parsed.workspaceCwd,
    clientExtensionMetadata: options.clientExtensionMetadata,
    clientExtensionFactories: options.clientExtensionFactories,
    clientCapabilities: options.clientCapabilities,
  });

  if (!isInteractiveRuntimeContract(runtimeCandidate)) {
    throw new Error("Remote runtime does not satisfy interactive runtime contract");
  }

  const runtime = runtimeCandidate;

  initTheme(runtime.session.settingsManager.getTheme(), true);
  const interactiveMode = new InteractiveMode(runtime, {
    verbose: parsed.verbose,
    initialMessage: parsed.initialMessage,
    initialMessages: parsed.initialMessages,
  });

  await interactiveMode.run();
}
