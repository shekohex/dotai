// Editor annotations from VS Code extension (ephemeral, in-memory only)
export interface EditorAnnotation {
  id: string;
  filePath: string;     // workspace-relative (e.g., "src/auth.ts")
  selectedText: string;
  lineStart: number;    // 1-based
  lineEnd: number;      // 1-based
  side?: 'old' | 'new';
  comment?: string;
  author?: string;
  source?: string;
  severity?: 'important' | 'nit' | 'pre_existing';
  reasoning?: string;
  kind?: 'issue' | 'nit' | 'suggestion' | 'question';
  title?: string;
  createdAt: number;
}

// Git review types shared between server and client
export type {
  DiffOption,
  WorktreeInfo,
  GitContext,
  JjEvoLogEntry,
  RecentCommit,
  AvailableBranches,
  CompareTargetConfig,
  CompareTargetPickerCopy,
  RepositoryContext,
} from "./review-core";
