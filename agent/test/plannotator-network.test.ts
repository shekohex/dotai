import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";

import { listenOnPort } from "../src/extensions/plannotator/server/network.ts";

class FakeServer extends EventEmitter {
  private readonly attempts: number[] = [];

  listen(port: number, _host: string, callback: () => void): void {
    this.attempts.push(port);
    if (port === 19432) {
      queueMicrotask(() => {
        this.emit("error", new Error("listen EADDRINUSE: address already in use"));
      });
      return;
    }
    queueMicrotask(() => {
      callback();
    });
  }

  address(): { port: number } {
    return { port: this.attempts.at(-1) ?? 0 };
  }

  close(callback: () => void): void {
    queueMicrotask(callback);
  }
}

describe("plannotator network", () => {
  const originalRemote = process.env.PLANNOTATOR_REMOTE;
  const originalPort = process.env.PLANNOTATOR_PORT;

  beforeEach(() => {
    process.env.PLANNOTATOR_REMOTE = "1";
    delete process.env.PLANNOTATOR_PORT;
  });

  afterEach(() => {
    if (originalRemote === undefined) {
      delete process.env.PLANNOTATOR_REMOTE;
    } else {
      process.env.PLANNOTATOR_REMOTE = originalRemote;
    }
    if (originalPort === undefined) {
      delete process.env.PLANNOTATOR_PORT;
    } else {
      process.env.PLANNOTATOR_PORT = originalPort;
    }
  });

  it("increments remote default port when base port is occupied", async () => {
    const server = new FakeServer();

    const result = await listenOnPort(server as never);

    expect(result.port).toBe(19433);
    expect(result.portSource).toBe("remote-default");
  });
});
