import { basename } from "node:path";

export function resolveRemoteSessionTarget(target: string): string {
  if (target.endsWith(".jsonl")) {
    const filename = basename(target, ".jsonl");
    const separatorIndex = filename.indexOf("_");
    if (separatorIndex >= 0 && separatorIndex < filename.length - 1) {
      return filename.slice(separatorIndex + 1);
    }
  }

  return target;
}
