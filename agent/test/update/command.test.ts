import { describe, expect, it } from "vitest";
import { parseUpdateCommand } from "../../src/update/command.js";

describe("parseUpdateCommand", () => {
  it("intercepts default and self updates", () => {
    expect(parseUpdateCommand(["update"])?.target).toBe("all");
    expect(parseUpdateCommand(["update", "--self"])?.target).toBe("self");
    expect(parseUpdateCommand(["update", "pi"])?.target).toBe("self");
  });

  it("leaves extension updates for upstream", () => {
    expect(parseUpdateCommand(["update", "--extensions"])?.target).toBe("extensions");
    expect(parseUpdateCommand(["update", "npm:@foo/bar"])?.target).toBe("extension");
  });

  it("leaves help for upstream", () => {
    expect(parseUpdateCommand(["update", "--help"])).toBeUndefined();
  });
});
