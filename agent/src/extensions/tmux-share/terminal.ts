import { execFileSync } from "node:child_process";
import { spawn, type IPty } from "zigpty";

export interface TmuxSessionInfo {
  sessionName: string;
  windowId: string;
  paneId: string;
  cols: number;
  rows: number;
}

export function getTmuxSessionInfo(): TmuxSessionInfo | null {
  if (process.env.TMUX === undefined || process.env.TMUX.length === 0) {
    return null;
  }

  try {
    const sessionName = execFileSync("tmux", ["display-message", "-p", "#{session_name}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const windowId = execFileSync("tmux", ["display-message", "-p", "#{window_id}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const paneId = execFileSync("tmux", ["display-message", "-p", "#{pane_id}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const colsStr = execFileSync("tmux", ["display-message", "-p", "#{window_width}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const rowsStr = execFileSync("tmux", ["display-message", "-p", "#{window_height}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const cols = Number(colsStr);
    const rows = Number(rowsStr);

    if (!sessionName || !windowId || !paneId || Number.isNaN(cols) || Number.isNaN(rows)) {
      return null;
    }

    return { sessionName, windowId, paneId, cols, rows };
  } catch {
    return null;
  }
}

export interface TmuxWatcher {
  pty: IPty;
  sessionInfo: TmuxSessionInfo;
  kill: () => void;
}

export function createTmuxWatcher(
  sessionInfo: TmuxSessionInfo,
  onData: (data: string) => void,
  onExit: (code: number) => void,
): TmuxWatcher {
  const pty = spawn("tmux", ["attach", "-t", sessionInfo.sessionName, "-r"], {
    cols: sessionInfo.cols,
    rows: sessionInfo.rows,
    name: "xterm-256color",
    env: { ...process.env, TERM: "xterm-256color" },
  });

  pty.onData((data) => {
    onData(typeof data === "string" ? data : data.toString("utf8"));
  });

  pty.onExit((info) => {
    onExit(info.exitCode);
  });

  return {
    pty,
    sessionInfo,
    kill: () => {
      try {
        pty.kill();
      } catch {}
      try {
        pty.close();
      } catch {}
    },
  };
}
