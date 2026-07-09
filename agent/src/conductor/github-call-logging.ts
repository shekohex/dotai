import { errorMessage } from "../utils/error-message.js";
import { ConductorExecError } from "./exec.js";
import type { CommandExec } from "./github-types.js";
import type { ConductorLogger } from "./logging.js";

export async function execLoggedGh(input: {
  action: string;
  args: string[];
  cwd: string | undefined;
  exec: CommandExec;
  isExpectedFailure?: (error: unknown) => boolean;
  logger: ConductorLogger;
  timeoutMs: number;
}): Promise<{ stdout: string; stderr: string }> {
  const context = githubCallContext(input.args, input.cwd, input.action);
  const startedAt = Date.now();
  input.logger.trace("GitHub call started", context);
  try {
    const result = await input.exec("gh", input.args, { cwd: input.cwd, timeout: input.timeoutMs });
    input.logger.trace("GitHub call finished", {
      ...context,
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    const message = errorMessage(error);
    const payload = {
      ...context,
      durationMs: Date.now() - startedAt,
      error: message,
    };
    if (input.isExpectedFailure?.(error) === true) {
      input.logger.debug("GitHub call returned expected non-success response", payload);
      throw error;
    }
    input.logger.warn("GitHub call failed", payload);
    throw error;
  }
}

export function isNoChecksReportedError(error: unknown): boolean {
  return (
    error instanceof ConductorExecError &&
    error.exitCode === 1 &&
    error.stderr.includes("no checks reported")
  );
}

function githubCallContext(
  args: string[],
  cwd: string | undefined,
  action: string,
): Record<string, unknown> {
  const endpoint = githubEndpoint(args);
  return {
    action,
    transport: githubTransport(args),
    command: ["gh", ...args.slice(0, 2)].join(" "),
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(cwd === undefined ? {} : { cwd }),
  };
}

function githubTransport(args: string[]): "graphql" | "rest" | "gh-cli" {
  if (args[0] !== "api") return "gh-cli";
  return args[1] === "graphql" ? "graphql" : "rest";
}

function githubEndpoint(args: string[]): string | undefined {
  if (args[0] !== "api" || args[1] === "graphql") return undefined;
  return args.find((arg, index) => index > 0 && !arg.startsWith("-") && !arg.includes("="));
}
