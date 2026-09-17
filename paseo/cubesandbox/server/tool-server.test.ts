import { describe, expect, it, vi } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { CubeToolServer } from "./tool-server.js";
import type { WorkService } from "./work-service.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("CubeToolServer capabilities", () => {
  it("binds opaque capabilities to exactly one initiating project scope", async () => {
    const works = {} as unknown as WorkService;
    const server = new CubeToolServer(works);
    await server.start();
    try {
      const firstUrl = new URL(
        server.createCapability({
          canonicalRoot: "/repo/first",
          paseoProjectId: "prj_first",
        }),
      );
      const secondUrl = new URL(
        server.createCapability({ canonicalRoot: "/repo/second" }),
      );
      const firstToken = firstUrl.pathname.split("/").at(-1)!;
      const secondToken = secondUrl.pathname.split("/").at(-1)!;

      expect(firstToken).not.toBe(secondToken);
      expect(server.capabilityForToken(firstToken)).toEqual({
        canonicalRoot: "/repo/first",
        paseoProjectId: "prj_first",
      });
      expect(server.capabilityForToken(secondToken)).toEqual({
        canonicalRoot: "/repo/second",
      });
      expect(server.capabilityForToken("unknown")).toBeUndefined();
      const unknownResponse = await fetch(
        new URL("/mcp/unknown", firstUrl.origin),
        { method: "POST" },
      );
      expect(unknownResponse.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("refuses Work Sandbox tools for a capability without a registered project", async () => {
    const works = {
      list: vi.fn(async () => []),
    } as unknown as WorkService;
    const server = new CubeToolServer(works);
    await server.start();
    try {
      const capabilityUrl = server.createCapability({
        canonicalRoot: "/repo/unregistered",
      });
      const client = new Client({
        name: "unregistered-test",
        version: "1.0.0",
      });
      const transport = new StreamableHTTPClientTransport(
        new URL(capabilityUrl),
      );
      await client.connect(transport);
      const result = await client.callTool({
        name: "cube_list_work",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(
        "not associated with a registered Paseo project",
      );
      expect(works.list).not.toHaveBeenCalled();
      await client.close();
    } finally {
      await server.close();
    }
  });

  it("stops intake and drains an in-flight tool call before closing", async () => {
    const listStarted = deferred<void>();
    const releaseList = deferred<void>();
    const works = {
      list: vi.fn(async () => {
        listStarted.resolve();
        await releaseList.promise;
        return [];
      }),
    } as unknown as WorkService;
    const server = new CubeToolServer(works);
    await server.start();
    const capabilityUrl = server.createCapability({
      canonicalRoot: "/repo/first",
      paseoProjectId: "prj_first",
    });
    const client = new Client({ name: "shutdown-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(capabilityUrl));
    await client.connect(transport);

    const call = client.callTool({ name: "cube_list_work", arguments: {} });
    await listStarted.promise;
    const closing = server.close();
    let closeFinished = false;
    void closing.then(() => {
      closeFinished = true;
    });
    await Promise.resolve();
    expect(closeFinished).toBe(false);
    expect(() =>
      server.createCapability({ canonicalRoot: "/repo/second" }),
    ).toThrow("closing");

    releaseList.resolve();
    await expect(call).resolves.toMatchObject({
      structuredContent: { works: [] },
    });
    await client.close();
    await closing;

    expect(closeFinished).toBe(true);
    await expect(
      client.callTool({ name: "cube_list_work", arguments: {} }),
    ).rejects.toThrow();
    expect(server.close()).toBe(closing);
  });
});
