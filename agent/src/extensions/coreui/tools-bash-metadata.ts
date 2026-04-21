export type BashCallMetadata = {
  description: string;
  command: string;
  timeout?: number;
  elapsed?: number;
  label: string;
};

export function getBashCallMetadata(
  args: { description?: unknown; command?: unknown; timeout?: unknown },
  elapsed?: number,
): BashCallMetadata {
  const description = readTrimmedString(args.description);
  const command = readTrimmedString(args.command);

  return {
    description,
    command,
    timeout: readNumberArg(args.timeout),
    elapsed,
    label: description || command || "...",
  };
}

function readTrimmedString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function readNumberArg(value: unknown): number | undefined {
  if (typeof value !== "number") {
    return undefined;
  }

  return value;
}
