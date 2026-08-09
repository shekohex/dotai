import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { projectAgentSessionEvent } from "../../src/acp/events.js";

const session = {
  sessionManager: { getCwd: () => "/workspace" },
} as AgentSession;

describe("ACP tool event projection", () => {
  test("projects tool start with kind, input, and file location", () => {
    expect(
      projectAgentSessionEvent(session, {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "read",
        args: { path: "/workspace/file.ts" },
      } as AgentSessionEvent),
    ).toEqual({
      type: "tool_start",
      toolCallId: "call-1",
      name: "read",
      title: "read /workspace/file.ts",
      kind: "read",
      rawInput: { path: "/workspace/file.ts" },
      locations: [{ path: "/workspace/file.ts" }],
    });
  });

  test("resolves relative tool locations against session cwd", () => {
    expect(
      projectAgentSessionEvent(session, {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "read",
        args: { path: "src/file.ts" },
      } as AgentSessionEvent),
    ).toMatchObject({ locations: [{ path: "/workspace/src/file.ts" }] });
  });

  test("uses the command as the bash tool card title", () => {
    expect(
      projectAgentSessionEvent(session, {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "date -u" },
      } as AgentSessionEvent),
    ).toMatchObject({ title: "date -u", kind: "execute" });
  });

  test("projects partial text progress", () => {
    expect(
      projectAgentSessionEvent(session, {
        type: "tool_execution_update",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "echo hello" },
        partialResult: { content: [{ type: "text", text: "hello\n" }] },
      } as AgentSessionEvent),
    ).toEqual({
      type: "tool_update",
      toolCallId: "call-1",
      name: "bash",
      content: [{ type: "text", text: "hello\n" }],
      rawOutput: { content: [{ type: "text", text: "hello\n" }] },
    });
  });

  test("projects completed image result without binary corruption", () => {
    const data = Buffer.from("image").toString("base64");
    expect(
      projectAgentSessionEvent(session, {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "image_gen",
        result: {
          content: [
            { type: "text", text: "generated" },
            { type: "image", data, mimeType: "image/png" },
          ],
          details: { path: "/workspace/image.png" },
        },
        isError: false,
      } as AgentSessionEvent),
    ).toEqual({
      type: "tool_end",
      toolCallId: "call-1",
      name: "image_gen",
      status: "completed",
      content: [
        { type: "text", text: "generated" },
        { type: "image", data, mimeType: "image/png" },
      ],
      rawOutput: {
        content: [
          { type: "text", text: "generated" },
          { type: "image", data, mimeType: "image/png" },
        ],
        details: { path: "/workspace/image.png" },
      },
    });
  });

  test("projects failed result", () => {
    expect(
      projectAgentSessionEvent(session, {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "grep",
        result: { content: [{ type: "text", text: "failed" }] },
        isError: true,
      } as AgentSessionEvent),
    ).toMatchObject({ type: "tool_end", toolCallId: "call-1", status: "failed" });
  });
});
