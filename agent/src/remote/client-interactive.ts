import {
  InteractiveMode,
  initTheme,
  type AgentSession,
  type AgentSessionRuntime,
} from "@mariozechner/pi-coding-agent";
import {
  RemoteAgentSessionRuntime,
  defaultSessionNameFromCwd,
  readRemotePrivateKey,
} from "./client-runtime.js";

type InteractiveSessionContract = Pick<
  AgentSession,
  | "sessionManager"
  | "settingsManager"
  | "modelRegistry"
  | "bindExtensions"
  | "subscribe"
  | "prompt"
  | "steer"
  | "followUp"
  | "sendUserMessage"
  | "setModel"
  | "cycleModel"
  | "setThinkingLevel"
  | "cycleThinkingLevel"
  | "getAvailableThinkingLevels"
  | "setSessionName"
  | "getActiveToolNames"
  | "getToolDefinition"
  | "reload"
>;

type InteractiveRuntimeContract = Pick<
  AgentSessionRuntime,
  | "diagnostics"
  | "modelFallbackMessage"
  | "newSession"
  | "switchSession"
  | "fork"
  | "importFromJsonl"
  | "dispose"
> & {
  session: InteractiveSessionContract;
};

function toInteractiveRuntimeHost(runtime: InteractiveRuntimeContract): AgentSessionRuntime {
  return runtime as unknown as AgentSessionRuntime;
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

function consumeFlagValue(args: string[], index: number): { value?: string; nextIndex: number } {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    return { nextIndex: index };
  }
  return { value, nextIndex: index + 1 };
}

export function shouldUseRemoteMode(args: string[]): boolean {
  if (process.env.PI_REMOTE_ORIGIN) {
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
    if (!arg) {
      continue;
    }
    if (arg === "--remote") {
      const consumed = consumeFlagValue(args, index);
      if (consumed.value) {
        parsed.remoteOrigin = consumed.value;
      }
      index = consumed.nextIndex;
      continue;
    }
    if (arg === "--remote-origin") {
      const consumed = consumeFlagValue(args, index);
      if (consumed.value) {
        parsed.remoteOrigin = consumed.value;
      }
      index = consumed.nextIndex;
      continue;
    }
    if (arg === "--remote-key-id") {
      const consumed = consumeFlagValue(args, index);
      if (consumed.value) {
        parsed.keyId = consumed.value;
      }
      index = consumed.nextIndex;
      continue;
    }
    if (arg === "--remote-private-key") {
      const consumed = consumeFlagValue(args, index);
      if (consumed.value) {
        parsed.privateKey = consumed.value;
      }
      index = consumed.nextIndex;
      continue;
    }
    if (arg === "--remote-private-key-path") {
      const consumed = consumeFlagValue(args, index);
      if (consumed.value) {
        parsed.privateKeyPath = consumed.value;
      }
      index = consumed.nextIndex;
      continue;
    }
    if (arg === "--remote-session") {
      const consumed = consumeFlagValue(args, index);
      if (consumed.value) {
        parsed.sessionId = consumed.value;
      }
      index = consumed.nextIndex;
      continue;
    }
    if (arg === "--remote-session-name") {
      const consumed = consumeFlagValue(args, index);
      if (consumed.value) {
        parsed.sessionName = consumed.value;
      }
      index = consumed.nextIndex;
      continue;
    }
    if (arg === "--verbose") {
      parsed.verbose = true;
      continue;
    }
    if (arg === "-p" || arg === "--prompt") {
      const consumed = consumeFlagValue(args, index);
      if (consumed.value) {
        parsed.initialMessage = consumed.value;
      }
      index = consumed.nextIndex;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    parsed.initialMessages.push(arg);
  }

  if (!parsed.remoteOrigin) {
    throw new Error("Missing PI_REMOTE_ORIGIN or --remote-origin");
  }
  if (!parsed.keyId) {
    throw new Error("Missing PI_REMOTE_KEY_ID or --remote-key-id");
  }

  return parsed;
}

export async function runRemoteInteractiveMode(args: string[]): Promise<void> {
  const parsed = parseRemoteArgs(args);
  const privateKey = await readRemotePrivateKey({
    privateKey: parsed.privateKey,
    privateKeyPath: parsed.privateKeyPath,
  });

  const runtime = await RemoteAgentSessionRuntime.create({
    origin: parsed.remoteOrigin,
    auth: {
      keyId: parsed.keyId,
      privateKey,
    },
    sessionId: parsed.sessionId,
    sessionName: parsed.sessionName ?? defaultSessionNameFromCwd(process.cwd()),
    cwd: process.cwd(),
  });

  initTheme(runtime.session.settingsManager.getTheme(), true);
  const runtimeHost = toInteractiveRuntimeHost(runtime);
  const interactiveMode = new InteractiveMode(runtimeHost, {
    verbose: parsed.verbose,
    initialMessage: parsed.initialMessage,
    initialMessages: parsed.initialMessages,
  });

  await interactiveMode.run();
}
