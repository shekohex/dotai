import { describe, expect, it, vi } from "vitest";

import { CubeToolServer } from "./tool-server.js";
import type { WorkService } from "./work-service.js";

describe("CubeToolServer capabilities", () => {
  it("binds opaque capabilities to exactly one initiating repository", async () => {
    const works = {
      bindRepositoryRoot: vi.fn(),
    } as unknown as WorkService;
    const server = new CubeToolServer(works);
    await server.start();
    try {
      const firstUrl = new URL(server.createCapability("/repo/first"));
      const secondUrl = new URL(server.createCapability("/repo/second"));
      const firstToken = firstUrl.pathname.split("/").at(-1)!;
      const secondToken = secondUrl.pathname.split("/").at(-1)!;

      expect(firstToken).not.toBe(secondToken);
      expect(server.repositoryRootForToken(firstToken)).toBe("/repo/first");
      expect(server.repositoryRootForToken(secondToken)).toBe("/repo/second");
      expect(server.repositoryRootForToken("unknown")).toBeUndefined();
      expect(works.bindRepositoryRoot).toHaveBeenCalledWith("/repo/first");
      expect(works.bindRepositoryRoot).toHaveBeenCalledWith("/repo/second");
      const unknownResponse = await fetch(
        new URL("/mcp/unknown", firstUrl.origin),
        { method: "POST" },
      );
      expect(unknownResponse.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
