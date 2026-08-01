import { createConnection } from "node:net";

import { parseHerdrSocketResponse } from "../herdr/client.js";
import { readString } from "../utils/unknown-data.js";

export type HerdrAgentRequest = {
  id: string;
  method:
    | "client.window_title.clear"
    | "client.window_title.set"
    | "notification.show"
    | "pane.current"
    | "pane.report_agent"
    | "pane.report_agent_session"
    | "pane.report_metadata"
    | "pane.release_agent"
    | "tab.rename";
  params: Record<string, unknown>;
};

export const HERDR_AGENT_SOURCE = "herdr:pi";

let reportSeq = Date.now() * 1000;

export function nextReportSeq(): number {
  reportSeq += 1;
  return reportSeq;
}

export function herdrEnabled(): boolean {
  return (
    process.env.PI_HERDR_AGENT_STATE !== "0" &&
    process.env.HERDR_ENV === "1" &&
    readString(process.env.HERDR_SOCKET_PATH) !== undefined &&
    readString(process.env.HERDR_PANE_ID) !== undefined
  );
}

export function currentPaneId(): string | undefined {
  return herdrEnabled() ? process.env.HERDR_PANE_ID : undefined;
}

export function currentTabId(): string | undefined {
  return herdrEnabled() ? readString(process.env.HERDR_TAB_ID) : undefined;
}

export function randomRequestId(kind: string): string {
  return `${HERDR_AGENT_SOURCE}:${kind}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

type HerdrSocketResponse = ReturnType<typeof parseHerdrSocketResponse>;

export async function sendRequest(request: HerdrAgentRequest): Promise<void> {
  if ((await sendRequestAttempt(request, 500)) !== undefined) return;
  await sendRequestAttempt(request, 1500);
}

export async function sendRequestWithResponse(
  request: HerdrAgentRequest,
): Promise<HerdrSocketResponse | undefined> {
  return (await sendRequestAttempt(request, 500)) ?? sendRequestAttempt(request, 1500);
}

function currentSocketPath(): string | undefined {
  return herdrEnabled() ? process.env.HERDR_SOCKET_PATH : undefined;
}

function sendRequestAttempt(
  request: HerdrAgentRequest,
  timeoutMs: number,
): Promise<HerdrSocketResponse | undefined> {
  const socketPath = currentSocketPath();
  if (socketPath === undefined) return Promise.resolve(void 0);

  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    let done = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (response: HerdrSocketResponse | undefined) => {
      if (done) return;
      done = true;
      if (timeout !== undefined) clearTimeout(timeout);
      socket.destroy();
      resolve(response);
    };

    socket.on("error", () => {
      finish(void 0);
    });
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      try {
        const response = parseHerdrSocketResponse(
          JSON.parse(buffer.slice(0, newlineIndex)) as unknown,
        );
        finish(response.id === request.id && !("error" in response) ? response : undefined);
      } catch {
        finish(void 0);
      }
    });
    socket.on("end", () => {
      finish(void 0);
    });
    timeout = setTimeout(() => {
      finish(void 0);
    }, timeoutMs);
    timeout.unref?.();
  });
}
