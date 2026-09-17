import { describe, expect, it, vi } from "vitest";

import { createRemotePaseoConnection } from "./remote-paseo.js";

describe("remote Paseo agent creation", () => {
  it("archives the workspace when agent creation fails and aggregates rollback failure", async () => {
    const archive = vi.fn(async () => ({ error: "archive failed" }));
    const client = {
      providers: {
        waitForReady: vi.fn(async () => ({
          entries: [
            {
              provider: "test",
              status: "ready",
              models: [{ id: "model", isDefault: true }],
            },
          ],
        })),
      },
      workspaces: {
        create: vi.fn(async () => ({
          id: "workspace-1",
          agents: {
            create: vi.fn(async () => {
              throw new Error("agent failed");
            }),
          },
        })),
        archive,
      },
    };
    const connection = createRemotePaseoConnection("server-1", client as never);

    await expect(
      connection.createAgent({
        prompt: "test",
        workspacePath: "/workspace/widget",
        defaultRef: "main",
        projectId: "widget",
        workId: "9d7aeb54-d838-4a30-8d42-c18fd27913bb",
        ordinal: 1,
      }),
    ).rejects.toMatchObject({
      message: "Remote agent creation and workspace rollback both failed",
      errors: [expect.any(Error), expect.any(Error)],
    });
    expect(archive).toHaveBeenCalledWith("workspace-1");
  });
});
