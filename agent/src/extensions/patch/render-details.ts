import { Type } from "typebox";
import { Value } from "typebox/value";
import { summarizePatchText } from "./parser.js";
import type { ApplyPatchDetails } from "./types.js";

const PatchFileDetailsSchema = Type.Object(
  {
    filePath: Type.String(),
    relativePath: Type.String(),
    sourceRelativePath: Type.Optional(Type.String()),
    type: Type.Union([
      Type.Literal("add"),
      Type.Literal("update"),
      Type.Literal("delete"),
      Type.Literal("move"),
    ]),
    diff: Type.String(),
    before: Type.String(),
    after: Type.String(),
    additions: Type.Number(),
    deletions: Type.Number(),
    movePath: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

const PatchTargetDetailsSchema = Type.Object(
  {
    relativePath: Type.String(),
    type: Type.Union([
      Type.Literal("add"),
      Type.Literal("update"),
      Type.Literal("delete"),
      Type.Literal("move"),
    ]),
    sourcePath: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

const ApplyPatchDetailsSchema = Type.Object(
  {
    diff: Type.String(),
    files: Type.Array(PatchFileDetailsSchema),
    targets: Type.Array(PatchTargetDetailsSchema),
    totalFiles: Type.Number(),
    completedFiles: Type.Number(),
  },
  { additionalProperties: true },
);

const ApplyPatchDetailsPartialSchema = Type.Object(
  {
    diff: Type.Optional(Type.String()),
    files: Type.Optional(Type.Array(PatchFileDetailsSchema)),
    targets: Type.Optional(Type.Array(PatchTargetDetailsSchema)),
    totalFiles: Type.Optional(Type.Number()),
    completedFiles: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
);

export function parseApplyPatchDetails(value: unknown): ApplyPatchDetails | undefined {
  if (!Value.Check(ApplyPatchDetailsSchema, value)) {
    return undefined;
  }

  return Value.Parse(ApplyPatchDetailsSchema, value);
}

export function getApplyPatchDetails(details: unknown, patchText: string): ApplyPatchDetails {
  const fullDetails = parseApplyPatchDetails(details);
  if (fullDetails !== undefined) {
    return fullDetails;
  }

  if (Value.Check(ApplyPatchDetailsPartialSchema, details)) {
    const patchDetails = Value.Parse(ApplyPatchDetailsPartialSchema, details);
    if (patchDetails.targets !== undefined) {
      const files = patchDetails.files ?? [];
      const completedFiles = patchDetails.completedFiles ?? files.length;
      return {
        diff: patchDetails.diff ?? "",
        files,
        targets: patchDetails.targets,
        totalFiles: patchDetails.totalFiles ?? patchDetails.targets.length,
        completedFiles,
      };
    }
  }

  const targets = summarizePatchText(patchText);
  return {
    diff: "",
    files: [],
    targets,
    totalFiles: targets.length,
    completedFiles: 0,
  };
}
