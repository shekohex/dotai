import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { asRecord, readNumber, readString } from "../utils/unknown-data.js";

const execFileAsync = promisify(execFile);
const OUTPUT_PREVIEW_LIMIT = 4000;

export class ConductorExecError extends Error {
  readonly command: string;
  readonly cwd?: string;
  readonly durationMs: number;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly timeoutMs?: number;

  constructor(input: {
    file: string;
    args: string[];
    cwd?: string;
    durationMs: number;
    exitCode?: number;
    signal?: string;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    timeoutMs?: number;
  }) {
    super(formatExecErrorMessage(input));
    this.name = "ConductorExecError";
    this.command = formatCommand(input.file, input.args);
    this.cwd = input.cwd;
    this.durationMs = input.durationMs;
    this.exitCode = input.exitCode;
    this.signal = input.signal;
    this.stdout = input.stdout;
    this.stderr = input.stderr;
    this.timedOut = input.timedOut;
    this.timeoutMs = input.timeoutMs;
  }
}

export async function execCommand(
  file: string,
  args: string[],
  options: { cwd?: string; timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  const startedAt = Date.now();
  try {
    const result = await execFileAsync(file, args, {
      cwd: options.cwd,
      timeout: options.timeout,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const record = asRecord(error);
    const signal = readString(record?.signal);
    const killed = record?.killed === true;
    throw new ConductorExecError({
      file,
      args,
      cwd: options.cwd,
      durationMs: Date.now() - startedAt,
      exitCode: readNumber(record?.code),
      signal,
      stdout: readString(record?.stdout) ?? "",
      stderr: readString(record?.stderr) ?? "",
      timedOut: killed && options.timeout !== undefined && signal !== undefined,
      timeoutMs: options.timeout,
    });
  }
}

function formatExecErrorMessage(input: {
  file: string;
  args: string[];
  cwd?: string;
  durationMs: number;
  exitCode?: number;
  signal?: string;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  timeoutMs?: number;
}): string {
  return [
    `Command failed: ${formatCommand(input.file, input.args)}`,
    ...(input.cwd === undefined ? [] : [`cwd: ${input.cwd}`]),
    `duration: ${input.durationMs}ms`,
    ...(input.timedOut && input.timeoutMs !== undefined
      ? [`timeout: ${input.timeoutMs}ms (process killed)`]
      : []),
    ...(input.exitCode === undefined ? [] : [`exit code: ${input.exitCode}`]),
    ...(input.signal === undefined ? [] : [`signal: ${input.signal}`]),
    `stdout:\n${formatOutput(input.stdout)}`,
    `stderr:\n${formatOutput(input.stderr)}`,
  ].join("\n");
}

function formatCommand(file: string, args: string[]): string {
  return [file, ...args].map((value) => shellQuote(value)).join(" ");
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function formatOutput(output: string): string {
  if (output.length === 0) return "(empty)";
  if (output.length <= OUTPUT_PREVIEW_LIMIT) return output.trimEnd();
  return `${output.slice(0, OUTPUT_PREVIEW_LIMIT).trimEnd()}\n... truncated ${output.length - OUTPUT_PREVIEW_LIMIT} character(s)`;
}
