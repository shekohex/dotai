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
import type { ClientCapabilities, RemoteExtensionMetadata } from "./schemas.js";

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
  sessionName?: string;
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
    "--remote-session-name",
    (parsed, value) => {
      parsed.sessionName = value;
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

function parseRemoteArgs(args: string[]): ParsedRemoteArgs {
  const parsed: ParsedRemoteArgs = {
    remoteOrigin: process.env.PI_REMOTE_ORIGIN ?? "",
    keyId: process.env.PI_REMOTE_KEY_ID ?? "",
    privateKey: process.env.PI_REMOTE_PRIVATE_KEY,
    privateKeyPath: process.env.PI_REMOTE_PRIVATE_KEY_PATH,
    sessionId: process.env.PI_REMOTE_SESSION_ID,
    sessionName: process.env.PI_REMOTE_SESSION_NAME,
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

  return parsed;
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

  const runtimeCandidate: unknown = await RemoteAgentSessionRuntime.create({
    origin: parsed.remoteOrigin,
    auth: {
      keyId: parsed.keyId,
      privateKey,
    },
    sessionId: parsed.sessionId,
    sessionName: parsed.sessionName ?? defaultSessionNameFromCwd(process.cwd()),
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
