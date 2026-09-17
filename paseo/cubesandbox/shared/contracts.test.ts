import { describe, expect, it } from "vitest";

import { createAgentInputSchema } from "../server/work-service.js";
import { destroyWorkRpc, listWorkRpc } from "./contracts.js";

describe("tool and RPC boundaries", () => {
  it("rejects project paths and unknown tool input fields", () => {
    expect(() =>
      createAgentInputSchema.parse({
        prompt: "work",
        repositoryRoot: "/untrusted/path",
      }),
    ).toThrow();
  });

  it("strictly validates RPC input and output", () => {
    expect(() =>
      listWorkRpc.input.parse({ repositoryRoot: "/repo" }),
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
