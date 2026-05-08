import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

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

afterEach(() => {
  const agentDir = process.env.TEST_PI_CODING_AGENT_DIR?.trim();
  if (!agentDir) {
    return;
  }

  fs.rmSync(path.join(agentDir, "settings.json"), { force: true });
});
