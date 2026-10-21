import type { PluginClientContext } from "@getpaseo/plugin/client";

import { ChangesPanel } from "./client/changes-panel.js";
import { DiffPanel } from "./client/diff-panel.js";
import { FilePanel } from "./client/file-panel.js";
import { FilesPanel } from "./client/files-panel.js";
import { PrismSettingsScreen } from "./client/settings.js";
import { contributeComposerPills } from "./client/composer-pill.js";
import { setPanelOpener } from "./client/store.js";
import {
  installShortcutRedirect,
  loadBuiltinHidingPreference,
  removeBuiltinHiding,
  restoreBuiltinHiding,
} from "./client/web.js";

export default function contribute(client: PluginClientContext) {
  setPanelOpener((id, options) => client.openPanel(id, options));
  restoreBuiltinHiding();
  const removeShortcuts = installShortcutRedirect(loadBuiltinHidingPreference, (action, workspaceId) => {
    try {
      client.openPanel(action, { workspaceId, location: "explorer" });
    } catch (error) {
      console.warn("[prism] could not open panel from shortcut", error);
    }
  });
  const cleanups = [
    client.addSettingsScreen({
      id: "prism",
      title: "Prism",
      icon: "Gem",
      Component: PrismSettingsScreen,
    }),
    client.addWorkspacePanel({
      id: "changes",
      title: "Changes",
      icon: "FileDiff",
      context: "workspace",
      locations: ["explorer", "workspace"],
      Component: ChangesPanel,
    }),
    client.addWorkspacePanel({
      id: "files",
      title: "Files",
      icon: "Files",
      context: "workspace",
      locations: ["explorer", "workspace"],
      Component: FilesPanel,
    }),
    client.addWorkspacePanel({
      id: "file",
      title: "File",
      icon: "FileText",
      context: "workspace",
      locations: ["workspace"],
      Component: FilePanel,
    }),
    client.addWorkspacePanel({
      id: "diff",
      title: "Diffs",
      icon: "FileDiff",
      context: "workspace",
      locations: ["workspace", "explorer"],
      Component: DiffPanel,
    }),
    ...(
      [
        ["changes", "Open Changes", "FileDiff"],
        ["files", "Open Files", "Files"],
        ["diff", "Open Diffs", "FileDiff"],
      ] as const
    ).map(([panel, title, icon]) =>
      client.addCommandCenterItem({
        id: `open-${panel}`,
        title,
        icon,
        context: "workspace",
        keywords: ["prism", panel],
        onSelect({ openPanel }) {
          openPanel(panel, { location: panel === "diff" ? "workspace" : "explorer" });
        },
      }),
    ),
    contributeComposerPills(client),
  ];
  return () => {
    removeShortcuts();
    removeBuiltinHiding();
    setPanelOpener(null);
    for (const remove of cleanups) remove();
  };
}
