import { expect, test } from "vitest";

import { terminalNotifyRuntime } from "../src/extensions/terminal-notify.js";
import { controlledTerminalOutput } from "./test-utils/controlled-terminal-output.js";

test("disables live Herdr reporting across the test suite", () => {
  expect(process.env.PI_HERDR_AGENT_STATE).toBe("0");
});

test("uses controlled terminal output across the test suite", () => {
  expect(terminalNotifyRuntime.stdoutWrite).toBe(controlledTerminalOutput.stdoutWrite);
  expect(terminalNotifyRuntime.writeFileSync).toBe(controlledTerminalOutput.writeFileSync);
  expect(terminalNotifyRuntime.execFileSync).toBe(controlledTerminalOutput.execFileSync);
});
