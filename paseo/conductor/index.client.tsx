import type { PluginClientContext } from "@getpaseo/plugin/client";

import { ConductorPanel, ProgressPanel } from "./client/panel.js";
import { ConductorsScreen } from "./client/screens.js";
import { contributeProgressPills } from "./client/progress/pill.js";
import { ConductorSettingsScreen } from "./client/settings.js";
import { ConductorsSidebarItem } from "./client/sidebar.js";
import { contributeTimeline } from "./client/timeline.js";

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addScreen({
      id: "conductors",
      title: "Conductors",
      Component: ConductorsScreen,
    }),
    client.addSettingsScreen({
      id: "conductor",
      title: "Conductor",
      icon: "Workflow",
      Component: ConductorSettingsScreen,
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
      context: "workspace",
      locations: ["workspace", "explorer"],
      Component: ConductorPanel,
    }),
    client.addWorkspacePanel({
      id: "progress",
      title: "Progress",
      icon: "ListChecks",
      context: "workspace",
      locations: ["workspace", "explorer"],
      Component: ProgressPanel,
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
      title: "Start conductor in this project",
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
      context: "workspace",
      onSelect: ({ openPanel }) => openPanel("conductor"),
    }),
    client.addCommandCenterItem({
      id: "open-progress-panel",
      title: "Open conductor progress",
      icon: "ListChecks",
      keywords: ["progress", "tickets", "dashboard"],
      context: "workspace",
      onSelect: ({ openPanel }) => openPanel("progress"),
    }),
  ];
  const removePills = contributeProgressPills(client);
  const removeTimeline = contributeTimeline(client);
  return () => {
    removePills();
    removeTimeline();
    for (const cleanup of cleanups) cleanup();
  };
}
