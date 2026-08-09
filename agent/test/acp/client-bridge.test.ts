import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createV1ClientBridge } from "../../src/acp/client-bridge.js";

describe("ACP v1 client bridge", () => {
  test("reads and writes client-visible file content", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "acp-client-bridge-"));
    const path = join(cwd, "file.ts");
    await writeFile(path, "saved");
    const requests: Array<[string, unknown]> = [];
    const client = {
      request: vi.fn((method: string, params: unknown) => {
        requests.push([method, params]);
        if (method === "fs/read_text_file") return Promise.resolve({ content: "unsaved" });
        return Promise.resolve({});
      }),
    };
    const bridge = createV1ClientBridge(client, "session-1", {
      readTextFile: true,
      writeTextFile: true,
      terminal: false,
    });
    const overrides = await bridge.createToolOverrides(cwd);
    const read = overrides.coreUi.read!(cwd);
    const write = overrides.coreUi.write!(cwd);

    await expect(
      read.execute("read-1", { path }, undefined, undefined, {} as never),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("unsaved") }],
    });
    await write.execute("write-1", { path, content: "updated" }, undefined, undefined, {} as never);

    expect(requests).toContainEqual([
      "fs/write_text_file",
      { sessionId: "session-1", path, content: "updated" },
    ]);
  });

  test("streams terminal output and releases terminal", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "acp-client-bridge-"));
    const requests: string[] = [];
    let outputCalls = 0;
    const client = {
      request: vi.fn((method: string) => {
        requests.push(method);
        if (method === "terminal/create") return Promise.resolve({ terminalId: "terminal-1" });
        if (method === "terminal/output") {
          outputCalls += 1;
          return Promise.resolve({
            output: outputCalls === 1 ? "hello" : "hello\nworld\n",
            truncated: false,
          });
        }
        if (method === "terminal/wait_for_exit") return Promise.resolve({ exitCode: 0 });
        return Promise.resolve({});
      }),
    };
    const bridge = createV1ClientBridge(client, "session-1", {
      readTextFile: false,
      writeTextFile: false,
      terminal: true,
    });
    const overrides = await bridge.createToolOverrides(cwd);
    const chunks: string[] = [];
    const result = await overrides.coreUi.bash!(cwd).execute(
      "bash-1",
      { command: "printf hello", timeout: 1_000 },
      undefined,
      (update) => {
        chunks.push(
          update.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
        );
      },
      {
        sessionManager: {
          getSessionId: () => "session-1",
          getSessionFile: () => undefined,
        },
      } as never,
    );

    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("hello"),
    });
    expect(requests).toContain("terminal/create");
    expect(requests).toContain("terminal/wait_for_exit");
    expect(requests.at(-1)).toBe("terminal/release");
    expect(chunks.join("\n")).toContain("hello");
  });

  test("omits overrides for unadvertised client capabilities", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "acp-client-bridge-"));
    const bridge = createV1ClientBridge({ request: () => Promise.resolve({}) }, "session-1", {
      readTextFile: false,
      writeTextFile: false,
      terminal: false,
    });
    const overrides = await bridge.createToolOverrides(cwd);
    expect(overrides.coreUi).toEqual({});
  });
});
