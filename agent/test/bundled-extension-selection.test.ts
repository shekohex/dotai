import { parseArgs } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createBundledExtensionFactories,
  getBundledExtensionDefinitions,
} from "../src/extensions/index.js";

function selectBundledExtensionNames(args: string[]): string[] {
  return createBundledExtensionFactories({ parsedArgs: parseArgs(args) }).map(
    (extension) => extension.name,
  );
}

describe("bundled extension selection", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("includes bundled subagent by default", () => {
    expect(selectBundledExtensionNames([])).toContain("subagent");
  });

  test("omits bundled subagent for T3 replacement in RPC mode", () => {
    expect(
      selectBundledExtensionNames([
        "--mode",
        "rpc",
        "--extension",
        "/x/pi-t3-subagent-extension.ts",
      ]),
    ).not.toContain("subagent");
  });

  test("omits bundled subagent for short extension flag in RPC mode", () => {
    expect(
      selectBundledExtensionNames(["--mode", "rpc", "-e", "/x/pi-t3-subagent-extension.ts"]),
    ).not.toContain("subagent");
  });

  test("keeps bundled subagent for unrelated explicit extensions", () => {
    expect(
      selectBundledExtensionNames(["--mode", "rpc", "--extension", "/x/other-extension.ts"]),
    ).toContain("subagent");
  });

  test("keeps bundled subagent in interactive mode", () => {
    expect(
      selectBundledExtensionNames(["--extension", "/x/pi-t3-subagent-extension.ts"]),
    ).toContain("subagent");
  });

  test("keeps bundled subagent when only T3 environment variables are present", () => {
    vi.stubEnv("T3_MCP_URL", "http://127.0.0.1:3000");
    vi.stubEnv("T3_MCP_BEARER_TOKEN", "token");
    vi.stubEnv("T3_PI_MCP_EXTENSION_PATH", "/x/pi-t3-subagent-extension.ts");

    expect(selectBundledExtensionNames(["--mode", "rpc"])).toContain("subagent");
  });

  test("removes only bundled subagent when T3 replacement is explicit", () => {
    const allBundledExtensionNames = getBundledExtensionDefinitions().map(
      (definition) => definition.id,
    );

    expect(
      selectBundledExtensionNames([
        "--mode",
        "rpc",
        "--extension",
        "/x/pi-t3-subagent-extension.ts",
      ]),
    ).toEqual(allBundledExtensionNames.filter((name) => name !== "subagent"));
  });
});
