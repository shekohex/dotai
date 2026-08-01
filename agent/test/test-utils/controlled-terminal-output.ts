type TerminalFileWrite = {
  data: string | NodeJS.ArrayBufferView;
  file: string | number;
};

type TerminalCommand = {
  args: readonly string[];
  command: string;
};

export const controlledTerminalOutput = {
  commands: [] as TerminalCommand[],
  fileWrites: [] as TerminalFileWrite[],
  stdoutWrites: [] as string[],
  execFileSync: (command: string, args: readonly string[] = []): never => {
    controlledTerminalOutput.commands.push({ command, args });
    throw new Error("Terminal commands are disabled in tests");
  },
  reset: (): void => {
    controlledTerminalOutput.commands.length = 0;
    controlledTerminalOutput.fileWrites.length = 0;
    controlledTerminalOutput.stdoutWrites.length = 0;
  },
  stdoutWrite: (sequence: string): boolean => {
    controlledTerminalOutput.stdoutWrites.push(sequence);
    return true;
  },
  writeFileSync: (file: string | number, data: string | NodeJS.ArrayBufferView): void => {
    controlledTerminalOutput.fileWrites.push({ file, data });
  },
};
