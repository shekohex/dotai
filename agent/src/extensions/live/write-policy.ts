import { Type } from "typebox";
import { Value } from "typebox/value";

import { getApplyPatchPaths, isPlanWritePathAllowed } from "../plannotator/tool-scope.js";

const FilePathInputSchema = Type.Object(
  {
    path: Type.String(),
  },
  { additionalProperties: true },
);

const ApplyPatchInputSchema = Type.Object(
  {
    patchText: Type.String(),
  },
  { additionalProperties: true },
);

export interface LiveWritePolicyBlock {
  block: true;
  reason: string;
}

function blocked(path?: string): LiveWritePolicyBlock {
  return {
    block: true,
    reason:
      path === undefined
        ? "Live mode limits direct file changes to Markdown documentation inside the working directory. Delegate code changes to a child session."
        : `Live mode limits direct file changes to Markdown documentation inside the working directory. Blocked: ${path}. Delegate code changes to a child session.`,
  };
}

export function enforceLiveWritePolicy(
  toolName: string,
  input: unknown,
  cwd: string,
): LiveWritePolicyBlock | undefined {
  if (toolName === "write" || toolName === "edit") {
    if (!Value.Check(FilePathInputSchema, input)) return blocked();
    const { path } = Value.Parse(FilePathInputSchema, input);
    return isPlanWritePathAllowed(path, cwd) ? undefined : blocked(path);
  }

  if (toolName !== "apply_patch") return undefined;
  if (!Value.Check(ApplyPatchInputSchema, input)) return blocked();
  const { patchText } = Value.Parse(ApplyPatchInputSchema, input);
  const paths = getApplyPatchPaths(patchText);
  if (paths.length === 0) return blocked();
  const blockedPath = paths.find((path) => !isPlanWritePathAllowed(path, cwd));
  return blockedPath === undefined ? undefined : blocked(blockedPath);
}
