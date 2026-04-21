import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";

export function shouldUsePatch(modelId: string | undefined): boolean {
  if (modelId === undefined || modelId.length === 0) {
    return false;
  }

  const normalizedModelId = modelId.toLowerCase();
  return (
    normalizedModelId.includes("gpt-") &&
    !normalizedModelId.includes("oss") &&
    !normalizedModelId.includes("gpt-4")
  );
}

export function sameToolSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) {
      return false;
    }
  }

  return true;
}

export function isApplyPatchShellCommand(command: string): boolean {
  return /(^|[\n;&|]\s*)(?:apply_patch|applypatch)\b/.test(command);
}

export function withFileMutationQueues<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
  if (paths.length === 0) {
    return fn();
  }

  const [first, ...rest] = paths;
  return withFileMutationQueue(first, () => withFileMutationQueues(rest, fn));
}
