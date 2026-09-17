import { describe, expect, it } from "vitest";

import { createAgentInputSchema } from "../server/work-service.js";
import {
  destroyWorkRpc,
  initConfigRpc,
  pauseWorkRpc,
  resumeWorkRpc,
} from "./contracts.js";

describe("tool and RPC boundaries", () => {
  it("rejects project paths and unknown tool input fields", () => {
    expect(() =>
      createAgentInputSchema.parse({
        prompt: "work",
        repositoryRoot: "/untrusted/path",
      }),
    ).toThrow();
  });

  it("accepts only project id and work id for mutations", () => {
    expect(
      pauseWorkRpc.input.parse({ projectId: "prj_1", workId: "work-1" }),
    ).toEqual({ projectId: "prj_1", workId: "work-1" });
    expect(() => pauseWorkRpc.input.parse({ workId: "work-1" })).toThrow();
    expect(() =>
      resumeWorkRpc.input.parse({
        projectId: "prj_1",
        workId: "work-1",
        repositoryRoot: "/repo",
      }),
    ).toThrow();
    expect(() => destroyWorkRpc.input.parse({ projectId: "prj_1" })).toThrow();
  });

  it("strictly validates RPC input and output", () => {
    expect(() =>
      initConfigRpc.input.parse({ repositoryRoot: "/repo" }),
    ).toThrow();
    expect(() =>
      destroyWorkRpc.output.parse({
        workId: "work-1",
        destroyed: true,
        secret: "not-allowed",
      }),
    ).toThrow();
  });
});
