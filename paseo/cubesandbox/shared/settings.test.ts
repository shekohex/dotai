import { describe, expect, it } from "vitest";

import { ALL_PROJECTS_VALUE, cubeSandboxSettings } from "./settings.js";

describe("cube sandbox settings", () => {
  it("defaults to no project selection", () => {
    expect(cubeSandboxSettings.schema.parse({})).toEqual({
      selectedProjectId: null,
    });
    expect(cubeSandboxSettings.scope).toBe("host");
  });

  it("accepts a persisted project id and rejects empty selections", () => {
    expect(
      cubeSandboxSettings.schema.parse({ selectedProjectId: "prj_1" }),
    ).toEqual({ selectedProjectId: "prj_1" });
    expect(() =>
      cubeSandboxSettings.schema.parse({ selectedProjectId: "" }),
    ).toThrow();
    expect(() =>
      cubeSandboxSettings.schema.parse({
        selectedProjectId: "prj_1",
        extra: true,
      }),
    ).toThrow();
  });

  it("keeps the all-projects sentinel distinct from project ids", () => {
    expect(ALL_PROJECTS_VALUE.startsWith("prj_")).toBe(false);
  });
});
