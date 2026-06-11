import { describe, expect, it } from "vitest";
import { parseVersionChannel } from "../../src/update/version.js";

describe("parseVersionChannel", () => {
  it("detects preview versions", () => {
    expect(parseVersionChannel("0.79.1-dev.2654a2b0")).toEqual({
      channel: "preview",
      commit: "2654a2b0",
    });
  });

  it("treats stable versions as latest", () => {
    expect(parseVersionChannel("0.79.1")).toEqual({ channel: "latest" });
  });
});
