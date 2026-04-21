import type { HandoffOptions } from "./shared.js";

function parseCommandArgs(args: string): { goal: string; options: HandoffOptions; error?: string } {
  let remaining = args.trim();
  const options: HandoffOptions = {};

  while (remaining.startsWith("-")) {
    const modeMatch = remaining.match(/^-mode\s+(\S+)(?:\s+|$)/);
    if (modeMatch) {
      options.mode = modeMatch[1];
      remaining = remaining.slice(modeMatch[0].length).trimStart();
      continue;
    }

    const modelMatch = remaining.match(/^-model\s+(\S+)(?:\s+|$)/);
    if (modelMatch) {
      options.model = modelMatch[1];
      remaining = remaining.slice(modelMatch[0].length).trimStart();
      continue;
    }

    return {
      goal: "",
      options,
      error: "Usage: /handoff [-mode <name>] [-model <provider/modelId>] <goal>",
    };
  }

  return {
    goal: remaining.trim(),
    options,
  };
}

export { parseCommandArgs };
