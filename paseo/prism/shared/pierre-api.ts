import type { Author } from "./review.js";

/** Host theme tokens the Pierre components are painted with. */
export interface PierreColors {
  surface0: string;
  surface1: string;
  surface2: string;
  border: string;
  foreground: string;
  foregroundMuted: string;
  accent: string;
  success: string;
  warning: string;
  danger: string;
}

export interface PierreFont {
  family: string;
  size: number;
  lineHeight: number;
}

export type DiffSide = "additions" | "deletions";

/** A review comment on one line of one file's diff. */
export interface ReviewComment {
  id: string;
  path: string;
  side: DiffSide;
  line: number;
  text: string;
  author: Author;
  createdAt: number;
  /** Still part of the unsubmitted review. */
  pending: boolean;
}

export interface DiffViewProps {
  patch: string;
  split: boolean;
  /** Bundled Highlights theme name for the tokens. */
  syntax: string;
  appearance: "dark" | "light";
  colors: PierreColors;
  code: PierreFont;
  comments: readonly ReviewComment[];
  /** Who is commenting: the GitHub user on the daemon's machine. */
  viewer: Author | null;
  /** The line a new comment is being written on, if any. */
  draft: { side: DiffSide; line: number } | null;
  onDraft(side: DiffSide, line: number): void;
  onAddComment(side: DiffSide, line: number, text: string): void;
  onCancelDraft(): void;
  onRemoveComment(id: string): void;
  onEditComment(id: string, text: string): void;
  /** Scroll to this line and flash it, once. */
  focus: { side: DiffSide; line: number } | null;
  onFocused(): void;
}

/** A file shown with syntax colors, optionally editable in place. */
export interface FileViewProps {
  name: string;
  content: string;
  /** While true the file is an editor; `content` is only the starting text. */
  editing: boolean;
  syntax: string;
  appearance: "dark" | "light";
  colors: PierreColors;
  code: PierreFont;
  /** The full text after every edit. */
  onEdit(text: string): void;
}

/** An image, video, audio file or PDF, assembled from file slices the daemon serves. */
export interface MediaViewProps {
  name: string;
  kind: "image" | "video" | "audio" | "pdf";
  mimeType: string;
  size: number;
  /** Changes whenever the file does, so an edit reloads the preview. */
  version: number;
  appearance: "dark" | "light";
  colors: PierreColors;
  fetchChunk(offset: number, length: number): Promise<string>;
  /** URLs that serve the file with HTTP Range, best first; this client may not reach any of them. */
  getUrls(): Promise<string[]>;
}

export interface FileIconProps {
  name: string;
  size: number;
  appearance: "dark" | "light";
  muted: string;
}

export type TreeStatus = "added" | "deleted" | "modified" | "renamed" | "untracked" | "ignored";

export interface TreeViewProps {
  /** Directories end with "/". */
  paths: readonly string[];
  /** Status by file path. */
  statuses: Readonly<Record<string, TreeStatus>>;
  /** Right-aligned `+N −M` text by file path. */
  stats: Readonly<Record<string, { additions: number; deletions: number }>>;
  /** Review comments per file path. */
  commentCounts: Readonly<Record<string, number>>;
  expandAll: boolean;
  search: string;
  colors: PierreColors;
  uiFontSize: number;
  onOpenFile(path: string): void;
  /** Right-click menu entries for a file or folder. */
  menu(path: string, isDir: boolean): readonly { id: string; label: string }[];
  onMenuAction(id: string, path: string): void;
}

export interface PierreView<Props> {
  update(props: Props): void;
  destroy(): void;
}

/** The API exposed by the web bundle (`scripts/web/entry.ts`). Only exists on web and desktop. */
export interface PierreApi {
  /** False where WebAssembly + SIMD is missing; the RN renderers take over. */
  supported: boolean;
  createDiffView(host: unknown, props: DiffViewProps): PierreView<DiffViewProps>;
  createFileView(parent: unknown, initial: FileViewProps): PierreView<FileViewProps>;
  createMediaView(parent: unknown, initial: MediaViewProps): PierreView<MediaViewProps>;
  createTreeView(host: unknown, props: TreeViewProps): PierreView<TreeViewProps>;
  /** A file-type icon from Pierre's icon set (the one Trees and diffs.com/icons use). */
  createFileIcon(host: unknown, props: FileIconProps): PierreView<FileIconProps>;
}
