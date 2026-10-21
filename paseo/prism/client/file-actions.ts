import { copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback } from "react";

import { useWorkspaceDirectory } from "./data.js";
import { showDiff, showFile } from "./store.js";

export type FileActionId = "open" | "edit" | "show-diff" | "copy-path" | "copy-relative-path";

export interface FileMenuItem {
  id: FileActionId;
  label: string;
}

/** What the right-click or long-press menu offers for a file or folder. */
export function fileMenuFor(isDir: boolean, changed: boolean): FileMenuItem[] {
  return [
    ...(isDir ? [] : [{ id: "open" as const, label: "Open" }, { id: "edit" as const, label: "Edit" }]),
    ...(changed ? [{ id: "show-diff" as const, label: "Show diff" }] : []),
    { id: "copy-path", label: "Copy path" },
    { id: "copy-relative-path", label: "Copy relative path" },
  ];
}

export function useFileActions(workspaceId: string): (action: FileActionId, path: string) => void {
  const cwd = useWorkspaceDirectory(workspaceId);
  const toast = useToast();
  return useCallback(
    (action, path) => {
      const bare = path.replace(/\/$/, "");
      const copy = (text: string) =>
        copyText(text).then(
          () => toast.show("Copied"),
          () => toast.error("Could not copy"),
        );
      if (action === "open") showFile(workspaceId, bare);
      else if (action === "edit") showFile(workspaceId, bare, true);
      else if (action === "show-diff") showDiff(workspaceId, bare);
      else if (action === "copy-relative-path") void copy(bare);
      else void copy(cwd ? `${cwd.replace(/\/$/, "")}/${bare}` : bare);
    },
    [workspaceId, cwd, toast],
  );
}
