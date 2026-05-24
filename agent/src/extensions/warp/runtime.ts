import {
  createTmuxPassthroughSequence,
  getTmuxClientTty,
  getTmuxPaneTty,
  terminalNotifyRuntime,
} from "../terminal-notify.js";

export const warpRuntime = {
  readProtocolVersion: (): string | undefined => process.env.WARP_CLI_AGENT_PROTOCOL_VERSION,
};

export const writeWarpCliAgentSequence = (sequence: string): void => {
  const paneTty = getTmuxPaneTty();
  if (paneTty === null) {
    terminalNotifyRuntime.stdoutWrite(sequence);
    return;
  }

  const clientTty = getTmuxClientTty();
  if (clientTty !== null) {
    try {
      terminalNotifyRuntime.writeFileSync(clientTty, sequence, { encoding: "utf8" });
      return;
    } catch {}

    try {
      terminalNotifyRuntime.writeFileSync(clientTty, createTmuxPassthroughSequence(sequence), {
        encoding: "utf8",
      });
      return;
    } catch {}
  }

  try {
    terminalNotifyRuntime.writeFileSync(paneTty, createTmuxPassthroughSequence(sequence), {
      encoding: "utf8",
    });
    return;
  } catch {}

  terminalNotifyRuntime.stdoutWrite(sequence);
};
