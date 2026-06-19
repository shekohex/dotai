import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  getBackgroundShellBackend,
  selectBackgroundShellBackend,
  warmBackgroundShellBackendAvailability,
} from "./background-bash-backends.js";
import type { BackgroundBackendName } from "./background-bash-backend.js";
import {
  BACKGROUND_SHELL_COMPLETION_MESSAGE,
  BACKGROUND_SHELL_POLL_MESSAGE,
  type BackgroundBashToolDetails,
  type BackgroundShellRun,
} from "./background-bash-types.js";
import { markBackgroundShellCompleted, trackBackgroundShellRun } from "./background-bash-ui.js";

const COMPLETED_CONTEXT_LINES = 20;
const POLL_CONTEXT_LINES = 5;
const MIN_POLL_INTERVAL_MS = 1000;
const MILLISECONDS_PER_SECOND = 1000;

type QuoteState = "single" | "double" | undefined;

type ShellScan = {
  backgroundOperators: number[];
  comments: ShellComment[];
};

type ShellComment = {
  end: number;
  index: number;
  text: string;
};

export type BackgroundCommand = {
  command: string;
  pollIntervalMs?: number;
};

type BackgroundRun = {
  backend: BackgroundBackendName;
  command: string;
  cwd: string;
  description: string;
  exitFile: string;
  id: string;
  lastPollOutput?: string;
  muxSession?: string;
  outputFile: string;
  pollTimer?: ReturnType<typeof setInterval>;
  startedAt: number;
  status: BackgroundShellRun["status"];
  targetId: string;
  targetLabel: string;
};

type BackgroundState = {
  completingExitFiles: Set<string>;
  runDir?: string;
  runDirPromise?: Promise<string>;
  runs: Map<string, BackgroundRun>;
  watcher?: FSWatcher;
};

const state: BackgroundState = {
  completingExitFiles: new Set(),
  runs: new Map(),
};

export function warmBackgroundShellAvailabilityCache(): void {
  warmBackgroundShellBackendAvailability();
}

export function parseBackgroundCommand(command: string): BackgroundCommand | undefined {
  const scan = scanShell(command);
  const comment = findTrailingComment(command, scan.comments);
  const commandBeforeComment =
    comment === undefined ? command.trimEnd() : command.slice(0, comment.index).trimEnd();
  const ampersandIndex = findFinalBackgroundOperator(command, commandBeforeComment.length, scan);

  if (ampersandIndex === undefined) {
    return undefined;
  }

  const foregroundCommand = buildForegroundCommand(commandBeforeComment, ampersandIndex);
  if (!foregroundCommand) {
    return undefined;
  }

  const pollIntervalMs = comment === undefined ? undefined : parsePollInterval(comment.text);
  if (pollIntervalMs === undefined) {
    return { command: foregroundCommand };
  }

  return { command: foregroundCommand, pollIntervalMs };
}

export async function runBackgroundCommand(input: {
  command: BackgroundCommand;
  ctx: ExtensionContext;
  description: string;
  pi: ExtensionAPI;
}): Promise<AgentToolResult<BackgroundBashToolDetails>> {
  const backend = await selectBackgroundShellBackend(input.ctx.cwd);

  const runDir = await getRunDir();
  ensureWatcher(input.pi, runDir);

  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const exitFile = join(runDir, `${id}.exit`);
  const outputFile = join(runDir, `${id}.out`);
  const scriptPath = join(runDir, `${id}.sh`);
  const script = buildScript(input.command.command, outputFile, exitFile);
  await writeFile(scriptPath, script, { mode: 0o700 });

  const windowName = formatWindowName(input.command.command);
  const target = await backend.launch({
    command: input.command.command,
    cwd: input.ctx.cwd,
    description: input.description,
    exitFile,
    id,
    label: windowName,
    outputFile,
    ...(input.command.pollIntervalMs === undefined
      ? {}
      : { pollIntervalMs: input.command.pollIntervalMs }),
    scriptPath,
    startedAt: Date.now(),
  });
  const startedAt = Date.now();
  const run: BackgroundRun = {
    backend: target.backend,
    command: input.command.command,
    cwd: input.ctx.cwd,
    description: input.description,
    exitFile,
    id,
    outputFile,
    ...(target.muxSession === undefined ? {} : { muxSession: target.muxSession }),
    startedAt,
    status: "running",
    targetId: target.targetId,
    targetLabel: target.targetLabel,
  };

  state.runs.set(exitFile, run);
  trackBackgroundShellRun(
    input.ctx,
    toBackgroundShellRun(run, input.ctx.cwd, input.command.pollIntervalMs),
  );

  if (input.command.pollIntervalMs !== undefined) {
    run.pollTimer = startPoller(input.pi, run, input.command.pollIntervalMs);
  }

  return {
    content: [
      {
        type: "text",
        text: formatStartedMessage(run, input.command.pollIntervalMs),
      },
    ],
    details: backgroundDetails(run, input.ctx.cwd, input.command.pollIntervalMs),
  };
}

function scanShell(command: string): ShellScan {
  const backgroundOperators: number[] = [];
  const comments: ShellComment[] = [];
  let quote: QuoteState;
  let escaped = false;
  let inBacktick = false;
  let commandSubstitutionDepth = 0;
  let groupDepth = 0;
  let inComment = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if (inComment) {
      if (char === "\n") {
        inComment = false;
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "single") {
      escaped = true;
      continue;
    }

    if (inBacktick) {
      if (char === "`") {
        inBacktick = false;
      }
      continue;
    }

    if (char === "`" && quote === undefined) {
      inBacktick = true;
      continue;
    }

    if (char === "'" && quote !== "double") {
      quote = quote === "single" ? undefined : "single";
      continue;
    }

    if (char === '"' && quote !== "single") {
      quote = quote === "double" ? undefined : "double";
      continue;
    }

    if (quote !== undefined) {
      continue;
    }

    if (char === "$" && command[index + 1] === "(") {
      commandSubstitutionDepth += 1;
      index += 1;
      continue;
    }

    if (commandSubstitutionDepth > 0) {
      if (char === ")") {
        commandSubstitutionDepth -= 1;
      }
      continue;
    }

    if (char === "(") {
      groupDepth += 1;
      continue;
    }

    if (char === ")") {
      groupDepth = Math.max(0, groupDepth - 1);
      continue;
    }

    const isTopLevel = groupDepth === 0;
    if (char === "#" && isTopLevel && isCommentStart(command, index)) {
      comments.push(readComment(command, index));
      inComment = true;
      continue;
    }

    if (char === "&" && isTopLevel && isSingleAmpersand(command, index)) {
      backgroundOperators.push(index);
    }
  }

  return { backgroundOperators, comments };
}

function readComment(command: string, index: number): ShellComment {
  const newlineIndex = command.indexOf("\n", index + 1);
  const end = newlineIndex === -1 ? command.length : newlineIndex;
  return { end, index, text: command.slice(index + 1, end).trim() };
}

function findTrailingComment(command: string, comments: ShellComment[]): ShellComment | undefined {
  return [...comments]
    .toReversed()
    .find((comment) => command.slice(comment.end).trim().length === 0);
}

function parsePollInterval(comment: string): number | undefined {
  const match = /^poll(?:\s*[:=]\s*|\s+)(\d+)\s*(ms|s|sec|secs|second|seconds)?\s*$/i.exec(comment);
  if (!match) {
    return undefined;
  }

  const rawInterval = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  const requestedPollIntervalMs =
    unit === undefined || unit === "ms" ? rawInterval : rawInterval * MILLISECONDS_PER_SECOND;
  return Math.max(requestedPollIntervalMs, MIN_POLL_INTERVAL_MS);
}

function isCommentStart(command: string, index: number): boolean {
  if (index === 0) {
    return true;
  }

  const previousCharacter = command[index - 1] ?? "";
  return /\s/.test(previousCharacter) || ";|&(".includes(previousCharacter);
}

function isSingleAmpersand(command: string, index: number): boolean {
  return command[index - 1] !== "&" && command[index + 1] !== "&";
}

function findFinalBackgroundOperator(
  command: string,
  commandBeforeCommentEnd: number,
  scan: ShellScan,
): number | undefined {
  return scan.backgroundOperators
    .filter((index) => index < commandBeforeCommentEnd)
    .toReversed()
    .find((index) => isFinalBackgroundOperator(command, index, commandBeforeCommentEnd));
}

function isFinalBackgroundOperator(command: string, index: number, end: number): boolean {
  const suffix = command.slice(index + 1, end);
  return suffix.trim().length === 0 || isHeredocBody(command.slice(0, index), suffix);
}

function buildForegroundCommand(commandBeforeComment: string, ampersandIndex: number): string {
  const prefix = commandBeforeComment.slice(0, ampersandIndex).trimEnd();
  const suffix = commandBeforeComment.slice(ampersandIndex + 1);
  if (suffix.trim().length === 0) {
    return prefix;
  }

  return `${prefix}${suffix}`.trimEnd();
}

function isHeredocBody(commandPrefix: string, suffix: string): boolean {
  if (!suffix.startsWith("\n") && !/^\s*\n/.test(suffix)) {
    return false;
  }

  const delimiter = findLastHeredocDelimiter(commandPrefix);
  if (delimiter === undefined) {
    return false;
  }

  return suffix
    .split("\n")
    .slice(1)
    .some((line) => line.trimEnd() === delimiter);
}

function findLastHeredocDelimiter(commandPrefix: string): string | undefined {
  const heredocPattern = /<<-?\s*(?:"([^"]+)"|'([^']+)'|(\S+))/g;
  let delimiter: string | undefined;
  let match: RegExpExecArray | null;

  while ((match = heredocPattern.exec(commandPrefix)) !== null) {
    delimiter = match[1] ?? match[2] ?? match[3];
  }

  return delimiter;
}

async function getRunDir(): Promise<string> {
  if (state.runDir !== undefined) {
    return state.runDir;
  }

  state.runDirPromise ??= mkdtemp(join(tmpdir(), "pi-background-bash-"));
  state.runDir = await state.runDirPromise;
  return state.runDir;
}

function ensureWatcher(pi: ExtensionAPI, runDir: string): void {
  if (state.watcher) {
    return;
  }

  state.watcher = watch(runDir, (_eventType, filename) => {
    if (filename === null) {
      return;
    }

    const exitFile = join(runDir, filename);
    setTimeout(() => {
      handleExitFile(pi, exitFile).catch(() => {});
    }, 100);
  });
  state.watcher.unref?.();
}

async function handleExitFile(pi: ExtensionAPI, exitFile: string): Promise<void> {
  const run = state.runs.get(exitFile);
  if (run === undefined || state.completingExitFiles.has(exitFile)) {
    return;
  }

  state.completingExitFiles.add(exitFile);
  try {
    if (!(await fileExists(exitFile))) {
      return;
    }

    state.runs.delete(exitFile);
    if (run.pollTimer) {
      clearInterval(run.pollTimer);
    }

    const exitCodeText = (await readFile(exitFile, "utf-8")).trim();
    const exitCode = exitCodeText.length === 0 ? "1" : exitCodeText;
    const output = await readOutputTail(run.outputFile, COMPLETED_CONTEXT_LINES);
    const parsedExitCode = Number(exitCode);
    const status = classifyExitCode(parsedExitCode);
    markBackgroundShellCompleted(run.id, parsedExitCode, status);
    const summary = formatCompletionSummary(status, exitCode);
    pi.sendMessage(
      {
        customType: BACKGROUND_SHELL_COMPLETION_MESSAGE,
        content: `${summary}\n\n${formatCommandBlock(output)}\n\nFull output: ${run.outputFile}`,
        display: true,
        details: {
          command: run.command,
          description: run.description,
          exitCode,
          outputFile: run.outputFile,
          status,
          targetLabel: run.targetLabel,
        },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  } finally {
    state.completingExitFiles.delete(exitFile);
  }
}

function formatCompletionSummary(
  status: Extract<BackgroundShellRun["status"], "completed" | "failed" | "killed">,
  exitCode: string,
): string {
  if (status === "completed") return "Background command completed with exit 0.";
  if (status === "killed") return `Background command stopped with exit ${exitCode}.`;
  return `Background command failed with exit ${exitCode}.`;
}

function classifyExitCode(
  exitCode: number,
): Extract<BackgroundShellRun["status"], "completed" | "failed" | "killed"> {
  if (exitCode === 0) return "completed";
  if (exitCode === 130 || exitCode === 137 || exitCode === 143) return "killed";
  return "failed";
}

function startPoller(
  pi: ExtensionAPI,
  run: BackgroundRun,
  pollIntervalMs: number,
): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    void sendPollMessage(pi, run, timer);
  }, pollIntervalMs);
  timer.unref?.();
  return timer;
}

async function sendPollMessage(
  pi: ExtensionAPI,
  run: BackgroundRun,
  timer: ReturnType<typeof setInterval>,
): Promise<void> {
  if (!state.runs.has(run.exitFile)) {
    clearInterval(timer);
    return;
  }

  const output = await readOutputTail(run.outputFile, POLL_CONTEXT_LINES);
  const pollDelta = diffPollOutput(run.lastPollOutput, output);
  run.lastPollOutput = output;
  if (pollDelta.length === 0) {
    return;
  }
  const pollPreview = formatPollPreviewBlock(pollDelta, POLL_CONTEXT_LINES);

  pi.sendMessage(
    {
      customType: BACKGROUND_SHELL_POLL_MESSAGE,
      content: `Background command poll: ${run.targetLabel}\nNew output since last poll. Completion will be reported automatically; do not use sleep/backend polling loops to wait.\n\n${pollPreview.text}\n\n${formatInspectHint(run)}`,
      display: true,
      details: {
        command: run.command,
        description: run.description,
        outputFile: run.outputFile,
        pollLineCount: pollPreview.visibleLineCount,
        pollOmittedLineCount: pollPreview.omittedLineCount,
        status: "running",
        targetLabel: run.targetLabel,
      },
    },
    { deliverAs: "followUp", triggerTurn: true },
  );
}

export function diffPollOutput(previous: string | undefined, current: string): string {
  if (previous === undefined || previous.length === 0) {
    return current;
  }

  if (current === previous) {
    return "";
  }

  const previousLines = previous.split("\n");
  const currentLines = current.split("\n");
  const maxOverlap = Math.min(previousLines.length, currentLines.length);

  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    const previousSuffix = previousLines.slice(previousLines.length - overlap);
    const currentPrefix = currentLines.slice(0, overlap);
    if (arraysEqual(previousSuffix, currentPrefix)) {
      return currentLines.slice(overlap).join("\n");
    }
  }

  return current;
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function buildScript(command: string, outputFile: string, exitFile: string): string {
  return `#!/usr/bin/env bash
set +e
: > ${shellQuote(outputFile)}
printf '$ %s\n' ${shellQuote(command)} >> ${shellQuote(outputFile)}
(
${command}
) 2>&1 | tee -a ${shellQuote(outputFile)}
__pi_bash_rc=\${PIPESTATUS[0]}
printf '%s\n' "$__pi_bash_rc" > ${shellQuote(exitFile)}
exit "$__pi_bash_rc"
`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function formatWindowName(command: string): string {
  const firstWord = command.trim().split(/[|;&\s]/)[0];
  const fallbackName = firstWord === undefined || firstWord.length === 0 ? "bash" : firstWord;
  const baseName = basename(fallbackName);
  return (baseName.length === 0 ? "bash" : baseName).slice(0, 30);
}

function formatStartedMessage(run: BackgroundRun, pollIntervalMs: number | undefined): string {
  const pollText = pollIntervalMs === undefined ? "" : ` Polling every ${pollIntervalMs}ms.`;
  return `Started background command in ${run.targetLabel}.${pollText}\nResult will be reported automatically when it finishes. Do not use sleep commands or backend polling loops to wait for completion.\n\n${formatInspectHint(run)}\nFull output: ${run.outputFile}`;
}

function formatInspectHint(run: BackgroundRun): string {
  return getBackgroundShellBackend(run.backend).formatInspectHint(run);
}

async function readOutputTail(outputFile: string, lines: number): Promise<string> {
  if (!(await fileExists(outputFile))) {
    return "(no output yet)";
  }

  const output = (await readFile(outputFile, "utf-8")).trimEnd();
  if (output.length === 0) {
    return "(no output)";
  }

  return output.split("\n").slice(-lines).join("\n");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function formatCommandBlock(output: string): string {
  return `\`\`\`\n${output}\n\`\`\``;
}

function formatPollPreviewBlock(
  output: string,
  lineLimit: number,
): { omittedLineCount: number; text: string; visibleLineCount: number } {
  const lines = output.split("\n");
  const visibleLines = lines.slice(-lineLimit);
  const omittedLineCount = Math.max(0, lines.length - visibleLines.length);
  const omittedText = omittedLineCount > 0 ? `_...${omittedLineCount} earlier lines_\n\n` : "";

  return {
    omittedLineCount,
    text: `${omittedText}_Last ${visibleLines.length} lines:_\n\n\`\`\`log\n${visibleLines.join("\n")}\n\`\`\``,
    visibleLineCount: visibleLines.length,
  };
}

function toBackgroundShellRun(
  run: BackgroundRun,
  _cwd: string,
  pollIntervalMs: number | undefined,
): BackgroundShellRun {
  return {
    command: run.command,
    cwd: run.cwd,
    description: run.description,
    exitFile: run.exitFile,
    id: run.id,
    outputFile: run.outputFile,
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
    startedAt: run.startedAt,
    status: run.status,
    backend: run.backend,
    ...(run.muxSession === undefined ? {} : { muxSession: run.muxSession }),
    targetId: run.targetId,
    targetLabel: run.targetLabel,
  };
}

function backgroundDetails(
  run: BackgroundRun,
  cwd: string,
  pollIntervalMs: number | undefined,
): BackgroundBashToolDetails {
  return {
    ...toBackgroundShellRun(run, cwd, pollIntervalMs),
    background: true,
  };
}
