import { describe, expect, it } from "vitest";
import { parseUpdateCommand } from "../../src/update/command.js";

describe("parseUpdateCommand", () => {
  it("intercepts wrapper self and all updates", () => {
    expect(parseUpdateCommand(["update"])?.target).toBe("self");
    expect(parseUpdateCommand(["update", "--self"])?.target).toBe("self");
    expect(parseUpdateCommand(["update", "pi"])?.target).toBe("self");
    expect(parseUpdateCommand(["update", "--all"])?.target).toBe("all");
  });

  it("leaves upstream update targets untouched", () => {
    expect(parseUpdateCommand(["update", "--extensions"])).toBeUndefined();
    expect(parseUpdateCommand(["update", "--models"])).toBeUndefined();
    expect(parseUpdateCommand(["update", "--extension", "npm:@foo/bar"])).toBeUndefined();
    expect(parseUpdateCommand(["update", "npm:@foo/bar"])).toBeUndefined();
    expect(parseUpdateCommand(["update", "--all", "--models"])).toBeUndefined();
    expect(parseUpdateCommand(["update", "--unknown"])).toBeUndefined();
  });

  it("leaves help for upstream", () => {
    expect(parseUpdateCommand(["update", "--help"])).toBeUndefined();
  });
});
