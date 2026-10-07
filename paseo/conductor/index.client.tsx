import type { PluginClientContext } from "@getpaseo/plugin/client";

import { ConductorPanel } from "./client/panel.js";
import { ConductorsScreen } from "./client/screens.js";
import { ConductorsSidebarItem } from "./client/sidebar.js";

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addScreen({
      id: "conductors",
      title: "Conductors",
      Component: ConductorsScreen,
    }),
    client.addSidebarHeaderItem({
      id: "conductors",
      title: "Conductors",
      Component: ConductorsSidebarItem,
    }),
    client.addWorkspacePanel({
      id: "conductor",
      title: "Conductor",
      icon: "Workflow",
      context: "agent",
      locations: ["workspace", "explorer"],
      Component: ConductorPanel,
    }),
    client.addCommandCenterItem({
      id: "new-conductor",
      title: "New conductor",
      icon: "Workflow",
      keywords: ["coordinator", "hub", "orchestrate"],
      context: "global",
      onSelect: ({ openScreen }) =>
        openScreen({ screenId: "conductors", params: { view: "new" } }),
    }),
    client.addCommandCenterItem({
      id: "conductor-memory",
      title: "Conductor memory and instructions",
      icon: "BookOpen",
      keywords: ["conductor", "memory", "CONDUCTOR.md", "instructions"],
      context: "global",
      onSelect: ({ openScreen }) =>
        openScreen({ screenId: "conductors", params: { view: "memory" } }),
    }),
    client.addCommandCenterItem({
      id: "new-conductor-here",
      title: "Start conductor in this workspace",
      icon: "Workflow",
      keywords: ["coordinator", "hub", "orchestrate"],
      context: "workspace",
      onSelect: ({ openScreen, workspace }) =>
        openScreen({
          screenId: "conductors",
          params: { workspaceId: workspace.id },
        }),
    }),
    client.addCommandCenterItem({
      id: "open-conductor-panel",
      title: "Open conductor panel",
      icon: "Workflow",
      context: "agent",
      onSelect: ({ openPanel }) => openPanel("conductor"),
    }),
  ];
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
