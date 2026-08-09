import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { createAcpMcpManager, resolveMcpToolName } from "../../src/acp/mcp.js";

describe("ACP client MCP", () => {
  test("connects to stdio server, lists tools, invokes, and cleans up", async () => {
    const manager = await createAcpMcpManager(
      [
        {
          type: "stdio",
          name: "fixture",
          command: process.execPath,
          args: [fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url))],
          env: {},
        },
      ],
      process.cwd(),
    );
    expect(manager.extensionFactories).toHaveLength(1);
    const definition = manager.toolDefinitions[0];
    expect(definition.name).toBe("echo");
    await expect(
      definition.execute("call-1", { text: "hello" }, undefined, undefined, {} as never),
    ).resolves.toMatchObject({ content: [{ type: "text", text: "hello" }] });
    await manager.dispose();
  });

  test("rejects unsupported transports", async () => {
    await expect(
      createAcpMcpManager(
        [{ type: "http", name: "remote", url: "https://example.com" }],
        process.cwd(),
      ),
    ).rejects.toThrow("Unsupported ACP MCP transport: http");
  });

  test("preserves unique names and prefixes collisions", () => {
    expect(resolveMcpToolName("echo", "fixture", new Set(["read"]))).toBe("echo");
    expect(resolveMcpToolName("read", "My Server", new Set(["read"]))).toBe("my_server__read");
  });
});
