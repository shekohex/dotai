export type TerminalOutput = {
  execFileSync: (
    command: string,
    args: string[],
    options: {
      encoding: "utf8";
      stdio: ["ignore", "pipe", "ignore"];
    },
  ) => string;
  stdoutWrite: (sequence: string) => boolean;
  writeFileSync: (
    file: string | number,
    data: string | NodeJS.ArrayBufferView,
    options: { encoding: "utf8" },
  ) => void;
};

declare global {
  var __shekohexControlledTerminalOutput: TerminalOutput | undefined;
}

export function installTerminalOutputOverride(output: TerminalOutput): void {
  globalThis.__shekohexControlledTerminalOutput = output;
}

export function readTerminalOutputOverride(): TerminalOutput | undefined {
  return globalThis.__shekohexControlledTerminalOutput;
}
