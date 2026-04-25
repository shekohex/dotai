import {
  SessionSelectorComponent,
  initTheme,
  type SessionInfo,
} from "@mariozechner/pi-coding-agent";
import { ProcessTerminal, TUI } from "@mariozechner/pi-tui";
import { defaultSettings } from "../../default-settings.js";
import type { AppSnapshot, SessionSummary } from "../schemas.js";
import { resolveRemoteSessionTarget } from "./session-target.js";

function toRemoteSessionInfo(summary: SessionSummary): SessionInfo {
  return {
    path: summary.sessionId,
    id: summary.sessionId,
    cwd: summary.cwd,
    name: summary.sessionName,
    created: new Date(summary.createdAt),
    modified: new Date(summary.updatedAt),
    messageCount: summary.messageCount,
    firstMessage: summary.sessionName,
    allMessagesText: `${summary.sessionName} ${summary.cwd} ${summary.sessionId}`,
  };
}

function buildRemoteSessionLists(
  snapshot: AppSnapshot,
  workspaceCwd?: string,
): {
  currentSessions: SessionInfo[];
  allSessions: SessionInfo[];
} {
  const allSessions = snapshot.sessionSummaries.map(toRemoteSessionInfo);
  const currentSessions =
    workspaceCwd === undefined || workspaceCwd.length === 0
      ? allSessions
      : allSessions.filter((session) => session.cwd === workspaceCwd);

  return { currentSessions, allSessions };
}

export function selectRemoteSessionId(
  snapshot: AppSnapshot,
  workspaceCwd?: string,
): Promise<string | undefined> {
  const { currentSessions, allSessions } = buildRemoteSessionLists(snapshot, workspaceCwd);
  initTheme(defaultSettings.theme, true);

  return new Promise<string | undefined>((resolve) => {
    const ui = new TUI(new ProcessTerminal());
    let settled = false;

    const selector = new SessionSelectorComponent(
      () => Promise.resolve(currentSessions),
      () => Promise.resolve(allSessions),
      (sessionPath) => {
        if (settled) {
          return;
        }
        settled = true;
        ui.stop();
        resolve(resolveRemoteSessionTarget(sessionPath));
      },
      () => {
        if (settled) {
          return;
        }
        settled = true;
        ui.stop();
        const cancelledSelection: string | undefined = undefined;
        resolve(cancelledSelection);
      },
      () => {
        ui.stop();
        process.exit(0);
      },
      () => {
        ui.requestRender();
      },
      { showRenameHint: false },
    );

    ui.addChild(selector);
    ui.setFocus(selector.getSessionList());
    ui.start();
  });
}
