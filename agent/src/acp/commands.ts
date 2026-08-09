import { VERSION, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { AcpAvailableCommand } from "./core.js";

const BUILT_IN_COMMANDS: AcpAvailableCommand[] = [
  { name: "settings", description: "Show session settings" },
  { name: "model", description: "Show or change active model", inputHint: "provider/model" },
  { name: "scoped-models", description: "Show scoped models" },
  { name: "export", description: "Export session", inputHint: "output path" },
  { name: "import", description: "Import session", inputHint: "input path" },
  { name: "share", description: "Share exported session" },
  { name: "copy", description: "Return last assistant response" },
  { name: "name", description: "Set session name", inputHint: "session name" },
  { name: "session", description: "Show session statistics" },
  { name: "changelog", description: "Show changelog" },
  { name: "hotkeys", description: "Show keyboard shortcuts" },
  { name: "fork", description: "Fork session from an entry", inputHint: "entry ID" },
  { name: "clone", description: "Clone current session" },
  { name: "tree", description: "Show session tree" },
  { name: "trust", description: "Show or change project trust" },
  { name: "login", description: "Configure provider credentials", inputHint: "provider" },
  { name: "logout", description: "Remove provider credentials", inputHint: "provider" },
  { name: "new", description: "Start a new session" },
  { name: "compact", description: "Compact session context", inputHint: "instructions" },
  { name: "resume", description: "Resume another session", inputHint: "session ID" },
  { name: "reload", description: "Reload extensions and resources" },
  { name: "quit", description: "Close current ACP session" },
];

type BuiltinHandler = (session: AgentSession, args: string) => Promise<string> | string;

const BUILTIN_HANDLERS = new Map<string, BuiltinHandler>([
  ["settings", (session) => formatSettings(session)],
  ["model", (session, args) => handleModel(session, args)],
  ["scoped-models", (session) => formatScopedModels(session)],
  ["export", (session, args) => exportSession(session, args)],
  ["import", (_session, args) => `Use ACP session/load to import ${args || "a session path"}.`],
  ["share", async (session) => `Session exported for sharing: ${await session.exportToHtml()}`],
  ["copy", (session) => session.getLastAssistantText() ?? "No assistant response available."],
  ["name", (session, args) => setSessionName(session, args)],
  ["session", (session) => JSON.stringify(session.getSessionStats(), null, 2)],
  ["changelog", () => `Pi ${VERSION}. See repository changelog for release notes.`],
  [
    "hotkeys",
    () => "ACP clients own keyboard shortcuts; use client command palette and cancel action.",
  ],
  ["fork", (session, args) => forkSession(session, args)],
  ["clone", (session) => cloneSession(session)],
  ["tree", (session) => JSON.stringify(session.sessionManager.getTree(), null, 2)],
  [
    "trust",
    (session) => `Project trust uses local Pi policy for ${session.sessionManager.getCwd()}.`,
  ],
  [
    "login",
    (_session, args) =>
      `Run interactive Pi /login${args ? ` ${args}` : ""} to configure credentials.`,
  ],
  [
    "logout",
    (_session, args) =>
      `Run interactive Pi /logout${args ? ` ${args}` : ""} to remove credentials.`,
  ],
  ["new", () => "Use ACP session/new to create another session."],
  ["compact", (session, args) => compactSession(session, args)],
  ["resume", (_session, args) => `Use ACP session/resume${args ? ` for ${args}` : ""}.`],
  [
    "reload",
    async (session) => {
      await session.reload();
      return "Extensions and resources reloaded.";
    },
  ],
  ["quit", () => "Use ACP session/close to close this session."],
]);

export function buildAcpCommandCatalog(session: AgentSession): AcpAvailableCommand[] {
  const commands = new Map<string, AcpAvailableCommand>();
  for (const command of session.extensionRunner.getRegisteredCommands()) {
    commands.set(command.invocationName, {
      name: command.invocationName,
      description: command.description ?? `Run /${command.invocationName}`,
      inputHint: command.getArgumentCompletions === undefined ? undefined : "arguments",
    });
  }
  for (const prompt of session.promptTemplates) {
    if (!commands.has(prompt.name)) {
      commands.set(prompt.name, {
        name: prompt.name,
        description: prompt.description,
        inputHint: prompt.argumentHint,
      });
    }
  }
  for (const skill of session.resourceLoader.getSkills().skills) {
    const name = `skill:${skill.name}`;
    if (!commands.has(name)) {
      commands.set(name, { name, description: skill.description, inputHint: "arguments" });
    }
  }
  for (const command of BUILT_IN_COMMANDS) {
    if (!commands.has(command.name)) commands.set(command.name, command);
  }
  return [...commands.values()].toSorted((left, right) => left.name.localeCompare(right.name));
}

export function executeHeadlessBuiltin(
  session: AgentSession,
  prompt: string,
): Promise<string | undefined> {
  if (!prompt.startsWith("/")) return Promise.resolve(void 0);
  const commandLine = prompt.slice(1).trim();
  const separator = commandLine.indexOf(" ");
  const name = separator < 0 ? commandLine : commandLine.slice(0, separator);
  const args = separator < 0 ? "" : commandLine.slice(separator + 1).trim();
  if (
    session.extensionRunner
      .getRegisteredCommands()
      .some((command) => command.invocationName === name) ||
    session.promptTemplates.some((template) => template.name === name)
  ) {
    return Promise.resolve(void 0);
  }
  const handler = BUILTIN_HANDLERS.get(name);
  return Promise.resolve(handler?.(session, args));
}

function formatSettings(session: AgentSession): string {
  return JSON.stringify(
    {
      model: session.model === undefined ? null : `${session.model.provider}/${session.model.id}`,
      thinkingLevel: session.thinkingLevel,
      tools: session.getActiveToolNames(),
      autoCompaction: session.autoCompactionEnabled,
      autoRetry: session.autoRetryEnabled,
    },
    null,
    2,
  );
}

async function handleModel(session: AgentSession, args: string): Promise<string> {
  if (args.length === 0) {
    return session.model === undefined
      ? "No active model."
      : `Active model: ${session.model.provider}/${session.model.id}`;
  }
  const separator = args.indexOf("/");
  if (separator <= 0 || separator === args.length - 1) {
    return "Model must use provider/model format.";
  }
  const model = session.modelRuntime.getModel(args.slice(0, separator), args.slice(separator + 1));
  if (model === undefined) return `Unknown model: ${args}`;
  await session.setModel(model);
  return `Active model: ${model.provider}/${model.id}`;
}

function formatScopedModels(session: AgentSession): string {
  if (session.scopedModels.length === 0) return "No scoped models configured.";
  return session.scopedModels
    .map(
      ({ model, thinkingLevel }) =>
        `${model.provider}/${model.id}${thinkingLevel === undefined ? "" : ` (${thinkingLevel})`}`,
    )
    .join("\n");
}

async function exportSession(session: AgentSession, args: string): Promise<string> {
  const path = args || undefined;
  if (path?.endsWith(".jsonl") === true) return `Session exported: ${session.exportToJsonl(path)}`;
  return `Session exported: ${await session.exportToHtml(path)}`;
}

function setSessionName(session: AgentSession, args: string): string {
  if (args.length === 0) return "Session name is required.";
  session.setSessionName(args);
  return `Session named: ${args}`;
}

function forkSession(session: AgentSession, args: string): string {
  if (args.length === 0) return "Entry ID is required.";
  const path = session.sessionManager.createBranchedSession(args);
  return path === undefined ? "Session persistence is disabled." : `Fork created: ${path}`;
}

function cloneSession(session: AgentSession): string {
  const leafId = session.sessionManager.getLeafId();
  if (leafId === null) return "Session has no entries to clone.";
  return forkSession(session, leafId);
}

async function compactSession(session: AgentSession, args: string): Promise<string> {
  await session.compact(args || undefined);
  return "Session context compacted.";
}
