import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { cleanupRegisteredTempPaths } from "./temp-paths.ts";

const suppressedStderrPatterns = [
  /^Error: UAT session is already complete; no pending checkpoint to render$/u,
  /^Error: verify-work classify requires --response <text>$/u,
  /^Error: UAT file is missing parseable Tests entries$/u,
  /^Error: Phase 1 has no user-observable tests to verify after filtering summaries$/u,
  /^Error: Phase 1 directory not found for verify-work$/u,
  /^\[gsd-tools\] WARNING: STATE\.md field "Current Phase"/u,
  /^\[gsd-tools\] WARNING: STATE\.md field "Current Plan"/u,
  /^\[gsd-tools\] WARNING: STATE\.md field "Last Activity"/u,
  /^\[gsd-tools\] WARNING: STATE\.md field "Last Activity Description"/u,
] as const;

const originalStderrWrite = process.stderr.write.bind(process.stderr);

// GSD CLI contract tests intentionally exercise failure/reporting paths in bundled CJS helpers.
// Those helpers write expected diagnostics to stderr even when the Vitest assertions pass, so we
// suppress only these known-noise lines here instead of changing runtime behavior globally.
process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
  const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  const trimmed = text.trimEnd();

  if (suppressedStderrPatterns.some((pattern) => pattern.test(trimmed))) {
    const callback = args.find((value) => typeof value === "function");
    if (typeof callback === "function") {
      callback();
    }
    return true;
  }

  return originalStderrWrite(
    chunk,
    ...(args as [BufferEncoding | undefined, ((error?: Error | null) => void) | undefined]),
  );
}) as typeof process.stderr.write;

const configuredAgentDir = process.env.PI_CODING_AGENT_DIR?.trim();

if (
  configuredAgentDir === undefined ||
  configuredAgentDir.length === 0 ||
  configuredAgentDir === "undefined" ||
  configuredAgentDir === "null"
) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-test-pi-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.TEST_PI_CODING_AGENT_DIR = agentDir;

  process.on("exit", () => {
    fs.rmSync(agentDir, { recursive: true, force: true });
  });
} else {
  process.env.TEST_PI_CODING_AGENT_DIR = configuredAgentDir;
}

afterEach(async () => {
  const agentDir = process.env.TEST_PI_CODING_AGENT_DIR?.trim();
  if (agentDir) {
    fs.rmSync(path.join(agentDir, "settings.json"), { force: true });
  }

  await cleanupRegisteredTempPaths();
});
