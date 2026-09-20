import { describe, expect, it, vi } from "vitest";

import { createRemotePaseoConnection } from "./remote-paseo.js";

describe("remote Paseo agent creation", () => {
  it("forwards decomposed runtime settings and validates supplied modes remotely", async () => {
    const agentCreate = vi.fn(async () => ({ id: "agent-1" }));
    const listModes = vi.fn(async () => ({
      provider: "codex",
      modes: [{ id: "full-access", label: "Full access" }],
      fetchedAt: "2026-09-17T00:00:00.000Z",
      requestId: "request-1",
    }));
    const client = {
      providers: {
        waitForReady: vi.fn(async () => ({
          entries: [
            {
              provider: "codex",
              status: "ready",
              models: [{ id: "gpt-5.6-luna", isDefault: true }],
            },
          ],
        })),
        listModes,
      },
      workspaces: {
        create: vi.fn(async () => ({
          id: "workspace-1",
          agents: { create: agentCreate },
        })),
        archive: vi.fn(async () => ({ error: null })),
      },
    };
    const connection = createRemotePaseoConnection("server-1", client as never);

    await connection.createAgent({
      prompt: "build quickly",
      workspacePath: "/workspace/widget",
      defaultRef: "main",
      projectId: "widget",
      workId: "9d7aeb54-d838-4a30-8d42-c18fd27913bb",
      ordinal: 1,
      provider: "codex",
      model: "gpt-5.6-luna",
      modeId: "full-access",
      thinkingOptionId: "xhigh",
      featureValues: { fast_mode: true },
    });

    expect(listModes).toHaveBeenCalledWith("codex", {
      cwd: "/workspace/widget",
    });
    expect(agentCreate).toHaveBeenCalledWith({
      config: {
        provider: "codex/gpt-5.6-luna",
        modeId: "full-access",
        thinkingOptionId: "xhigh",
        featureValues: { fast_mode: true },
      },
    });
  });

  it("leaves mode unset when remote provider exposes no modes", async () => {
    const agentCreate = vi.fn(async () => ({ id: "agent-1" }));
    const client = {
      providers: {
        waitForReady: vi.fn(async () => ({
          entries: [
            {
              provider: "pi",
              status: "ready",
              models: [{ id: "default", isDefault: true }],
            },
          ],
        })),
      },
      workspaces: {
        create: vi.fn(async () => ({
          id: "workspace-1",
          agents: { create: agentCreate },
        })),
        archive: vi.fn(async () => ({ error: null })),
      },
    };
    const connection = createRemotePaseoConnection("server-1", client as never);

    await connection.createAgent({
      prompt: "inspect repository",
      workspacePath: "/workspace/widget",
      defaultRef: "main",
      projectId: "widget",
      workId: "9d7aeb54-d838-4a30-8d42-c18fd27913bb",
      ordinal: 1,
      provider: "pi",
    });

    expect(agentCreate).toHaveBeenCalledWith({
      config: { provider: "pi/default" },
    });
  });

  it("delivers one terminal callback with the latest assistant message", async () => {
    let timelineHandler: ((event: unknown) => void) | undefined;
    const unsubscribeTimeline = vi.fn();
    const unsubscribeAgent = vi.fn();
    const refetch = vi.fn(async () => ({
      entries: [
        {
          seq: 1,
          timestamp: "2026-09-20T00:00:00.000Z",
          item: { type: "assistant_message", text: "Final answer" },
        },
      ],
    }));
    const client = {
      agents: {
        ref: vi.fn(() => ({
          timeline: {
            subscribe: vi.fn((handler) => {
              timelineHandler = handler;
              return Object.assign(unsubscribeTimeline, {
                ready: Promise.resolve(),
              });
            }),
            refetch,
          },
          subscribe: vi.fn(() => unsubscribeAgent),
          refresh: vi.fn(async () => null),
        })),
      },
    };
    const connection = createRemotePaseoConnection("server-1", client as never);
    const completion = vi.fn(async () => undefined);
    await connection.watchAgent("agent-1", completion);

    timelineHandler?.({
      agentId: "agent-1",
      event: { type: "turn_started", provider: "codex", turnId: "turn-1" },
    });
    timelineHandler?.({
      agentId: "agent-1",
      event: { type: "turn_completed", provider: "codex", turnId: "turn-1" },
    });
    await vi.waitFor(() => {
      expect(completion).toHaveBeenCalledWith({
        status: "idle",
        lastAssistantMessage: "Final answer",
      });
    });
    timelineHandler?.({
      agentId: "agent-1",
      event: {
        type: "attention_required",
        provider: "codex",
        reason: "finished",
        timestamp: "2026-09-20T00:00:01.000Z",
        shouldNotify: true,
      },
    });
    expect(completion).toHaveBeenCalledTimes(1);
    expect(unsubscribeTimeline).toHaveBeenCalledOnce();
    expect(unsubscribeAgent).toHaveBeenCalledOnce();
  });

  it("delivers completion from agent status when timeline start is missed", async () => {
    let agentHandler: ((update: unknown) => void) | undefined;
    const refetch = vi.fn(async () => ({ entries: [] }));
    const client = {
      agents: {
        ref: vi.fn(() => ({
          timeline: {
            subscribe: vi.fn(() =>
              Object.assign(vi.fn(), { ready: Promise.resolve() }),
            ),
            refetch,
          },
          subscribe: vi.fn((handler) => {
            agentHandler = handler;
            return vi.fn();
          }),
          refresh: vi.fn(async () => null),
        })),
      },
    };
    const connection = createRemotePaseoConnection("server-1", client as never);
    const completion = vi.fn(async () => undefined);
    await connection.watchAgent("agent-1", completion);

    agentHandler?.({
      kind: "upsert",
      agent: { id: "agent-1", status: "running", activeTurn: { id: "turn-1" } },
    });
    agentHandler?.({
      kind: "upsert",
      agent: { id: "agent-1", status: "idle", activeTurn: null },
    });

    await vi.waitFor(() => {
      expect(completion).toHaveBeenCalledWith({ status: "idle" });
    });
  });

  it("refetches remote activity through the managed agent timeline", async () => {
    const timeline = {
      requestId: "request-1",
      agentId: "agent-1",
      agent: null,
      direction: "after" as const,
      projection: "projected" as const,
      epoch: "epoch-1",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 1, maxSeq: 2, nextSeq: 3 },
      startCursor: { epoch: "epoch-1", seq: 1 },
      endCursor: { epoch: "epoch-1", seq: 2 },
      hasOlder: false,
      hasNewer: true,
      entries: [],
      error: null,
    };
    const refetch = vi.fn(async () => timeline);
    const client = {
      agents: {
        ref: vi.fn(() => ({ timeline: { refetch } })),
      },
    };
    const connection = createRemotePaseoConnection("server-1", client as never);

    await expect(
      connection.getAgentTimeline("agent-1", {
        direction: "after",
        cursor: { epoch: "epoch-1", seq: 1 },
        limit: 10,
        projection: "projected",
      }),
    ).resolves.toEqual(timeline);
    expect(refetch).toHaveBeenCalledWith({
      direction: "after",
      cursor: { epoch: "epoch-1", seq: 1 },
      limit: 10,
      projection: "projected",
    });
  });

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
