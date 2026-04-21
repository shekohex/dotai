export type Hunk =
  | { type: "add"; path: string; contents: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; move_path?: string; chunks: UpdateFileChunk[] };

export type UpdateFileChunk = {
  old_lines: string[];
  new_lines: string[];
  change_context?: string;
  is_end_of_file?: boolean;
};

export type PatchFileChange = {
  filePath: string;
  oldContent: string;
  newContent: string;
  type: "add" | "update" | "delete" | "move";
  movePath?: string;
  diff: string;
  additions: number;
  deletions: number;
};

export type PatchFileDetails = {
  filePath: string;
  relativePath: string;
  sourceRelativePath?: string;
  type: "add" | "update" | "delete" | "move";
  diff: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
  movePath?: string;
};

export type PatchTargetDetails = {
  relativePath: string;
  type: "add" | "update" | "delete" | "move";
  sourcePath?: string;
};

export type ApplyPatchDetails = {
  diff: string;
  files: PatchFileDetails[];
  targets: PatchTargetDetails[];
  totalFiles: number;
  completedFiles: number;
};

export type ApplyPatchRenderState = {
  applyPatchDetails?: ApplyPatchDetails;
  applyPatchSignature?: string;
  callComponent?: unknown;
  callText?: string;
};
