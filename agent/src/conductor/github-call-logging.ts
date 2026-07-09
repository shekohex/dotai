import { errorMessage } from "../utils/error-message.js";
import { ConductorExecError } from "./exec.js";
import type { CommandExec } from "./github-types.js";
import type { ConductorLogger } from "./logging.js";

const GH_READ_MAX_ATTEMPTS = 2;

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
  const maxAttempts = isRetryableReadCall(input.args) ? GH_READ_MAX_ATTEMPTS : 1;
  for (let attempt = 1; ; attempt += 1) {
    const startedAt = Date.now();
    input.logger.trace("GitHub call started", { ...context, attempt, maxAttempts });
    try {
      const result = await input.exec("gh", input.args, {
        cwd: input.cwd,
        timeout: input.timeoutMs,
      });
      input.logger.trace("GitHub call finished", {
        ...context,
        attempt,
        durationMs: Date.now() - startedAt,
        maxAttempts,
      });
      return result;
    } catch (error) {
      const message = errorMessage(error);
      const payload = {
        ...context,
        attempt,
        durationMs: Date.now() - startedAt,
        error: message,
        maxAttempts,
      };
      if (attempt < maxAttempts && isEmptyOutputTimeoutError(error)) {
        input.logger.debug("GitHub call timed out; retrying", payload);
        continue;
      }
      if (input.isExpectedFailure?.(error) === true) {
        input.logger.debug("GitHub call returned expected non-success response", payload);
        throw error;
      }
      input.logger.warn("GitHub call failed", payload);
      throw error;
    }
  }
}

export function isEmptyOutputTimeoutError(error: unknown): boolean {
  return (
    error instanceof ConductorExecError &&
    error.timedOut &&
    error.stdout.length === 0 &&
    error.stderr.length === 0
  );
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

function isRetryableReadCall(args: string[]): boolean {
  if (args[0] === "pr") return ["checks", "list", "view"].includes(args[1] ?? "");
  if (args[0] === "repo") return args[1] === "view";
  if (args[0] !== "api" || args[1] === "graphql") return false;
  const methodIndex = args.findIndex((arg) => arg === "-X" || arg === "--method");
  if (methodIndex < 0) return true;
  return ["GET", "HEAD"].includes((args[methodIndex + 1] ?? "GET").toUpperCase());
}

function githubEndpoint(args: string[]): string | undefined {
  if (args[0] !== "api" || args[1] === "graphql") return undefined;
  return args.find(
    (arg, index) => index > 0 && !arg.startsWith("-") && (!arg.includes("=") || arg.includes("/")),
  );
}
