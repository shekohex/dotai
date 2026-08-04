import net, { type Server, type Socket } from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { SubagentParentMessageSchema, type SubagentParentMessage } from "./parent-message-types.js";

export const SubagentIpcConfigSchema = Type.Object(
  {
    endpoint: Type.String(),
    token: Type.String(),
  },
  { additionalProperties: false },
);

export const SubagentChildEventFrameSchema = Type.Object(
  {
    kind: Type.Literal("child_event"),
    sessionId: Type.String(),
    token: Type.String(),
    event: Type.Unsafe<ExtensionEvent>(
      Type.Object({ type: Type.String() }, { additionalProperties: true }),
    ),
  },
  { additionalProperties: false },
);

export const SubagentParentMessageFrameSchema = Type.Object(
  {
    kind: Type.Literal("parent_message"),
    sessionId: Type.String(),
    token: Type.String(),
    message: SubagentParentMessageSchema,
  },
  { additionalProperties: false },
);

export type SubagentChildIpcEvent = ExtensionEvent;
export type SubagentIpcConfig = Static<typeof SubagentIpcConfigSchema>;
export type SubagentChildEventFrame = Omit<
  Static<typeof SubagentChildEventFrameSchema>,
  "event"
> & {
  event: SubagentChildIpcEvent;
};
export type SubagentParentMessageFrame = Static<typeof SubagentParentMessageFrameSchema>;

export type SubagentChildEvent = {
  sessionId: string;
  event: SubagentChildIpcEvent;
};

export type SubagentParentMessageEvent = {
  sessionId: string;
  message: SubagentParentMessage;
};

export type SubagentIpcServer = {
  readonly endpoint: string;
  createRoute(sessionId: string): SubagentIpcConfig;
  onChildEvent(listener: (event: SubagentChildEvent) => void): () => void;
  onParentMessage(listener: (event: SubagentParentMessageEvent) => void): () => void;
  dispose(): void;
};

export function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function createJsonLineReader(onValue: (value: unknown) => void): (chunk: Buffer) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.toString("utf8");
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.trim().length === 0) {
        continue;
      }
      try {
        onValue(JSON.parse(line));
      } catch {
        continue;
      }
    }
  };
}

function createEndpoint(): { endpoint: string; cleanupPath?: string } {
  if (process.platform === "win32") {
    return { endpoint: `\\\\.\\pipe\\pi-subagent-${process.pid}-${randomUUID()}` };
  }
  const directory = mkdtempSync(path.join("/tmp", "pi-sg-"));
  return { endpoint: path.join(directory, "s.sock"), cleanupPath: directory };
}

export function createSubagentIpcServer(): SubagentIpcServer {
  const { endpoint, cleanupPath } = createEndpoint();
  const routes = new Map<string, string>();
  const listeners = new Set<(event: SubagentChildEvent) => void>();
  const parentMessageListeners = new Set<(event: SubagentParentMessageEvent) => void>();
  const sockets = new Set<Socket>();
  const server: Server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
    socket.on(
      "data",
      createJsonLineReader((value) => {
        const childEventFrame = Value.Check(SubagentChildEventFrameSchema, value);
        const parentMessageFrame = Value.Check(SubagentParentMessageFrameSchema, value);
        if (!childEventFrame && !parentMessageFrame) {
          return;
        }
        const frame = childEventFrame
          ? Value.Parse(SubagentChildEventFrameSchema, value)
          : Value.Parse(SubagentParentMessageFrameSchema, value);
        const routeToken = routes.get(frame.sessionId);
        if (routeToken !== frame.token) {
          return;
        }
        if (frame.kind === "parent_message") {
          const parentMessage: SubagentParentMessageEvent = {
            sessionId: frame.sessionId,
            message: frame.message,
          };
          for (const listener of parentMessageListeners) listener(parentMessage);
          return;
        }
        const childEvent: SubagentChildEvent = {
          sessionId: frame.sessionId,
          event: frame.event,
        };
        for (const listener of listeners) {
          listener(childEvent);
        }
      }),
    );
  });
  server.on("error", () => {});
  server.listen(endpoint);
  server.unref();
  return {
    endpoint,
    createRoute(sessionId) {
      const existingToken = routes.get(sessionId);
      const token = existingToken ?? randomUUID();
      routes.set(sessionId, token);
      return { endpoint, token };
    },
    onChildEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onParentMessage(listener) {
      parentMessageListeners.add(listener);
      return () => {
        parentMessageListeners.delete(listener);
      };
    },
    dispose() {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close();
      routes.clear();
      listeners.clear();
      parentMessageListeners.clear();
      if (cleanupPath !== undefined) {
        rmSync(cleanupPath, { recursive: true, force: true });
      }
    },
  };
}

export function connectSubagentIpcClient(input: { sessionId: string; config: SubagentIpcConfig }): {
  emit(event: SubagentChildIpcEvent): void;
  emitParentMessage(message: SubagentParentMessage): void;
  dispose(): void;
  disposeAfterFlush(): void;
} {
  const socket = net.createConnection(input.config.endpoint);
  socket.on("error", () => {});
  return {
    emit(event) {
      const frame: SubagentChildEventFrame = {
        kind: "child_event",
        sessionId: input.sessionId,
        token: input.config.token,
        event,
      };
      socket.write(serializeJsonLine(frame));
    },
    emitParentMessage(message) {
      const frame: SubagentParentMessageFrame = {
        kind: "parent_message",
        sessionId: input.sessionId,
        token: input.config.token,
        message,
      };
      socket.write(serializeJsonLine(frame));
    },
    dispose() {
      socket.destroy();
    },
    disposeAfterFlush() {
      socket.end();
    },
  };
}
