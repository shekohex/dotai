import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { createTmuxWatcher, getTmuxSessionInfo, type TmuxSessionInfo } from "./terminal.js";
import {
  buildShareUrls,
  clearShareState,
  decrementConnectionCount,
  incrementConnectionCount,
  setShareState,
  type ShareState,
} from "./state.js";

const PORT_START = 3133;
const PORT_END = 3232;

export interface TmuxShareHandle {
  server: Server;
  wss: WebSocketServer;
  state: ShareState;
  close: () => Promise<void>;
}

function getResourcePath(name: string): string {
  return join(import.meta.dirname, "..", "..", "resources", "tmux-share", name);
}

async function serveHtml(response: ServerResponse): Promise<void> {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(await readFile(getResourcePath("index.html"), "utf8"));
}

function captureWindowSnapshot(sessionInfo: TmuxSessionInfo): string | null {
  try {
    const output = execFileSync(
      "tmux",
      ["capture-pane", "-t", sessionInfo.paneId, "-p", "-e", "-J", "-S", "-"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 },
    );
    if (output.length === 0) {
      return null;
    }
    return `\u001B[H\u001B[2J${output}`;
  } catch {
    return null;
  }
}

function forcePtyRedraw(watcher: ReturnType<typeof createTmuxWatcher>): void {
  const { cols, rows } = watcher.sessionInfo;
  try {
    watcher.pty.resize(cols + 1, rows);
    watcher.pty.resize(cols, rows);
  } catch {
    // best effort
  }
}

function tryBindPort(host: string, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

async function findFreePort(host: string): Promise<{ server: Server; port: number }> {
  for (let port = PORT_START; port <= PORT_END; port++) {
    try {
      const server = await tryBindPort(host, port);
      return { server, port };
    } catch {
      continue;
    }
  }
  throw new Error(`No free port in range ${PORT_START}-${PORT_END}`);
}

export async function startTmuxShare(options: {
  host?: string;
  environment?: NodeJS.ProcessEnv;
}): Promise<TmuxShareHandle> {
  const environment = options.environment ?? process.env;
  const host = options.host ?? "127.0.0.1";

  const sessionInfo = getTmuxSessionInfo();
  if (!sessionInfo) {
    throw new Error("Not running inside a tmux session");
  }

  const { server, port } = await findFreePort(host);
  const serverTeardown = new Promise<void>((resolve) => {
    server.on("close", resolve);
  });

  const wss = new WebSocketServer({ noServer: true });

  const urls = buildShareUrls(port, environment);
  const state: ShareState = {
    port,
    sessionInfo,
    startedAt: Date.now(),
    connectionCount: 0,
    ...urls,
  };
  setShareState(state);

  let watcher = createTmuxWatcher(
    sessionInfo,
    (data) => {
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(data, { binary: false });
        }
      }
    },
    (_code) => {
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: "tmux-exited" }), { binary: false });
        }
      }
    },
  );

  server.on("upgrade", (request, socket, head) => {
    if (request.url !== undefined && request.url.startsWith("/ws")) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        ws.on("message", () => {
          // read-only: drop all incoming messages
        });

        ws.on("close", () => {
          decrementConnectionCount();
        });

        incrementConnectionCount();
        ws.send(
          JSON.stringify({
            type: "init",
            cols: sessionInfo.cols,
            rows: sessionInfo.rows,
            sessionName: sessionInfo.sessionName,
          }),
          { binary: false },
        );

        const snapshot = captureWindowSnapshot(sessionInfo);
        if (snapshot !== null) {
          ws.send(`\u001Bc`, { binary: false });
          ws.send(snapshot, { binary: false });
        }

        forcePtyRedraw(watcher);
      });
    } else {
      socket.destroy();
    }
  });

  server.on("request", (request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      serveHtml(response).then(
        () => {},
        () => {
          response.writeHead(500);
          response.end();
        },
      );
      return;
    }
    if (url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, port, connections: wss.clients.size }));
      return;
    }
    response.writeHead(404);
    response.end();
  });

  const close = async (): Promise<void> => {
    watcher.kill();
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: "server-shutdown" }), { binary: false });
        client.close();
      }
    }
    wss.close();
    server.close();
    await serverTeardown;
    clearShareState();
  };

  return { server, wss, state, close };
}
