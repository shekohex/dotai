import { describe, expect, it } from "vitest";
import {
  createUpdateCommand,
  makePackageSpec,
  parseRequestedInstallMethod,
  stripInstallMethodFlags,
} from "../../src/update/package-manager.js";

describe("package-manager update helpers", () => {
  it("parses explicit install method flags", () => {
    expect(parseRequestedInstallMethod(["update", "--bun"])).toBe("bun");
    expect(stripInstallMethodFlags(["update", "--bun", "--force"])).toEqual(["update", "--force"]);
  });

  it("uses preview tag for bun preview installs", () => {
    expect(makePackageSpec("0.79.1-dev.2654a2b0", "bun", "preview")).toBe(
      "@shekohex/agent@preview",
    );
    expect(makePackageSpec("0.79.1-dev.2654a2b0", "npm", "preview")).toBe(
      "@shekohex/agent@0.79.1-dev.2654a2b0",
    );
  });

  it("builds npm install command with userconfig", () => {
    expect(
      createUpdateCommand({
        method: "npm",
        packageSpec: "@shekohex/agent@0.79.1",
        npmrcPath: "/tmp/.npmrc",
      }),
    ).toMatchObject({
      command: "npm",
      args: ["install", "--global", "@shekohex/agent@0.79.1", "--userconfig", "/tmp/.npmrc"],
    });
  });
});
