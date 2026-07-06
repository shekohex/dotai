import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const ParsedConductorCommandSchema = Type.Union([
  Type.Object({ kind: Type.Literal("help"), topic: Type.Optional(Type.String()) }),
  Type.Object({ kind: Type.Literal("serve") }),
  Type.Object({ kind: Type.Literal("reconcile") }),
  Type.Object({ kind: Type.Literal("status"), json: Type.Boolean() }),
  Type.Object({ kind: Type.Literal("runs"), json: Type.Boolean() }),
  Type.Object({
    kind: Type.Literal("run"),
    reference: Type.String(),
    launchFlags: Type.Array(Type.String()),
    configOverrides: Type.Object({
      repoPath: Type.Optional(Type.String()),
      branchTemplate: Type.Optional(Type.String()),
      branchPrefix: Type.Optional(Type.String()),
      branchKind: Type.Optional(Type.String()),
      baseRef: Type.Optional(Type.String()),
      worktreeRoot: Type.Optional(Type.String()),
    }),
  }),
  Type.Object({ kind: Type.Literal("logs"), runId: Type.String() }),
  Type.Object({
    kind: Type.Literal("send"),
    runId: Type.String(),
    message: Type.String(),
    delivery: Type.Union([Type.Literal("steer"), Type.Literal("followUp")]),
  }),
  Type.Object({ kind: Type.Literal("stop"), runId: Type.String() }),
  Type.Object({ kind: Type.Literal("pause"), runId: Type.String() }),
  Type.Object({ kind: Type.Literal("resume"), runId: Type.String() }),
  Type.Object({ kind: Type.Literal("retry"), runId: Type.String() }),
  Type.Object({ kind: Type.Literal("cleanup"), runId: Type.String(), merged: Type.Boolean() }),
  Type.Object({ kind: Type.Literal("cleanup-merged") }),
  Type.Object({
    kind: Type.Literal("daemon"),
    action: Type.Union([
      Type.Literal("start"),
      Type.Literal("stop"),
      Type.Literal("restart"),
      Type.Literal("status"),
    ]),
  }),
  Type.Object({
    kind: Type.Literal("cleanup-gc"),
    olderThanDays: Type.Optional(Type.Number({ minimum: 1 })),
    vacuum: Type.Boolean(),
  }),
  Type.Object({ kind: Type.Literal("config-init") }),
  Type.Object({ kind: Type.Literal("config-validate") }),
  Type.Object({
    kind: Type.Literal("completion"),
    shell: Type.Union([Type.Literal("bash"), Type.Literal("zsh")]),
  }),
]);

export type ParsedConductorCommand = Static<typeof ParsedConductorCommandSchema>;

export function parseConductorArgs(args: string[]): ParsedConductorCommand {
  const [command, ...rest] = args;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    return { kind: "help", ...(rest[0] === undefined ? {} : { topic: rest[0] }) };
  }
  if (rest.includes("--help") || rest.includes("-h")) return { kind: "help", topic: command };

  if (command === "serve") return { kind: "serve" };
  if (command === "reconcile") return { kind: "reconcile" };
  if (command === "status") return { kind: "status", json: rest.includes("--json") };
  if (command === "runs") return { kind: "runs", json: rest.includes("--json") };
  if (command === "run") {
    const [reference, ...launchFlags] = rest;
    if (reference === undefined)
      throw new Error(
        "Usage: pi conductor run <issue-url|owner/repo#n|issue-number|project-item-id> [flags]",
      );
    const parsedFlags = parseRunFlags(launchFlags);
    return Value.Parse(ParsedConductorCommandSchema, {
      kind: "run",
      reference,
      launchFlags: parsedFlags.launchFlags,
      configOverrides: parsedFlags.configOverrides,
    });
  }
  if (command === "logs") return { kind: "logs", runId: required(rest[0], "logs <run-id>") };
  if (command === "send") return parseSend(rest);
  if (command === "stop") return { kind: "stop", runId: required(rest[0], "stop <run-id>") };
  if (command === "pause") return { kind: "pause", runId: required(rest[0], "pause <run-id>") };
  if (command === "resume") return { kind: "resume", runId: required(rest[0], "resume <run-id>") };
  if (command === "retry") return { kind: "retry", runId: required(rest[0], "retry <run-id>") };
  if (command === "daemon") return parseDaemon(rest);
  if (command === "cleanup") return parseCleanup(rest);
  if (command === "config") return parseConfig(rest);
  if (command === "completion") return parseCompletion(rest);

  throw new Error(`Unknown conductor command: ${command}`);
}

function parseCompletion(args: string[]): ParsedConductorCommand {
  const shell = args[0];
  if (shell === "bash" || shell === "zsh") return { kind: "completion", shell };
  throw new Error("Usage: pi conductor completion <bash|zsh>");
}

function parseDaemon(args: string[]): ParsedConductorCommand {
  const action = args[0];
  if (action === "start" || action === "stop" || action === "restart" || action === "status") {
    return { kind: "daemon", action };
  }
  throw new Error("Usage: pi conductor daemon <start|stop|restart|status>");
}

function parseSend(args: string[]): ParsedConductorCommand {
  const [runId, ...parts] = args;
  let delivery: "steer" | "followUp" = "steer";
  const messageParts: string[] = [];
  let literalMessage = false;
  for (const part of parts) {
    if (!literalMessage && part === "--") {
      literalMessage = true;
      continue;
    }
    if (!literalMessage && part === "--follow-up") {
      delivery = "followUp";
      continue;
    }
    if (!literalMessage && (part === "--now" || part === "--steer")) {
      delivery = "steer";
      continue;
    }
    messageParts.push(part);
  }
  const message = messageParts.join(" ").trim();
  if (runId === undefined || message.length === 0) {
    throw new Error("Usage: pi conductor send <run-id> <message> [--follow-up]");
  }
  return Value.Parse(ParsedConductorCommandSchema, { kind: "send", runId, message, delivery });
}

function parseRunFlags(args: string[]): {
  launchFlags: string[];
  configOverrides: Record<string, string>;
} {
  const launchFlags: string[] = [];
  const configOverrides: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    const parsed = parseRunConfigOverride(arg, args[index + 1]);
    if (parsed === undefined) {
      launchFlags.push(arg);
      continue;
    }
    configOverrides[parsed.key] = parsed.value;
    if (parsed.consumedNext) index += 1;
  }
  return { launchFlags, configOverrides };
}

function parseRunConfigOverride(
  arg: string,
  next: string | undefined,
): { key: string; value: string; consumedNext: boolean } | undefined {
  const equalMatch =
    /^(--(?:repo-path|branch-template|branch-prefix|branch-kind|base-ref|worktree-root))=(.+)$/u.exec(
      arg,
    );
  if (equalMatch?.[1] !== undefined && equalMatch[2] !== undefined) {
    return { key: runOverrideKey(equalMatch[1]), value: equalMatch[2], consumedNext: false };
  }
  if (!isRunOverrideFlag(arg)) return undefined;
  if (next === undefined || next.startsWith("--")) {
    throw new Error(`Missing value for ${arg}`);
  }
  return { key: runOverrideKey(arg), value: next, consumedNext: true };
}

function isRunOverrideFlag(arg: string): boolean {
  return [
    "--repo-path",
    "--branch-template",
    "--branch-prefix",
    "--branch-kind",
    "--base-ref",
    "--worktree-root",
  ].includes(arg);
}

function runOverrideKey(flag: string): string {
  return flag.slice(2).replaceAll(/-([a-z])/g, (_match, char: string) => char.toUpperCase());
}

function parseCleanup(args: string[]): ParsedConductorCommand {
  if (args.includes("--gc")) return parseCleanupGc(args.filter((arg) => arg !== "--gc"));
  const merged = args.includes("--merged");
  const runIds = args.filter((arg) => arg !== "--merged");
  if (merged && runIds.length === 0) return { kind: "cleanup-merged" };
  if (runIds.length !== 1) throw new Error("Usage: pi conductor cleanup <run-id|--merged>");
  const runId = required(runIds[0], "cleanup <run-id|--merged>");
  return { kind: "cleanup", runId, merged };
}

function parseCleanupGc(args: string[]): ParsedConductorCommand {
  let vacuum = true;
  let olderThanDays: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--no-vacuum") {
      vacuum = false;
      continue;
    }
    if (arg === "--vacuum") {
      vacuum = true;
      continue;
    }
    if (arg === "--older-than-days") {
      const value = args[index + 1];
      if (value === undefined) throw new Error("Missing value for --older-than-days");
      olderThanDays = parsePositiveInteger(value, "--older-than-days");
      index += 1;
      continue;
    }
    const equalMatch = /^--older-than-days=(\d+)$/u.exec(arg ?? "");
    if (equalMatch?.[1] !== undefined) {
      olderThanDays = parsePositiveInteger(equalMatch[1], "--older-than-days");
      continue;
    }
    throw new Error("Usage: pi conductor cleanup --gc [--older-than-days N] [--no-vacuum]");
  }
  return Value.Parse(ParsedConductorCommandSchema, {
    kind: "cleanup-gc",
    ...(olderThanDays === undefined ? {} : { olderThanDays }),
    vacuum,
  });
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function parseConfig(args: string[]): ParsedConductorCommand {
  if (args[0] === "init") return { kind: "config-init" };
  if (args[0] === "validate") return { kind: "config-validate" };
  throw new Error("Usage: pi conductor config <init|validate>");
}

function required(value: string | undefined, usage: string): string {
  if (value === undefined) throw new Error(`Usage: pi conductor ${usage}`);
  return value;
}
