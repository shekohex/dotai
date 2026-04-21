export type FileReference = {
  path: string;
  display: string;
  exists: boolean;
  isDirectory: boolean;
};

export type FileEntry = {
  canonicalPath: string;
  resolvedPath: string;
  displayPath: string;
  exists: boolean;
  isDirectory: boolean;
  status?: string;
  inRepo: boolean;
  isTracked: boolean;
  isReferenced: boolean;
  hasSessionChange: boolean;
  lastTimestamp: number;
};

export type GitStatusEntry = {
  status: string;
  exists: boolean;
  isDirectory: boolean;
};

export type FileToolName = "write" | "edit";

export type SessionFileChange = {
  operations: Set<FileToolName>;
  lastTimestamp: number;
};
