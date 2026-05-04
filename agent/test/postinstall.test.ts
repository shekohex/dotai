import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getDependencyPatchApplyMarkerPath } from "../scripts/postinstall.mjs";

describe("postinstall dependency patch marker", () => {
  it("stores patch tracking outside package node_modules", () => {
    const markerPath = getDependencyPatchApplyMarkerPath();

    expect(markerPath).toMatch(/\.pi[\\/]agent[\\/]state[\\/]dependency-patches[\\/]/);
    expect(markerPath).toMatch(/\.applied$/);
    expect(markerPath).not.toMatch(
      /[\\/]node_modules[\\/]\.shekohex-agent-dependency-patches-applied$/,
    );
    expect(markerPath).not.toContain("/scripts/");
  });

  it("does not rerun postinstall logic from bin wrapper", () => {
    const binContents = readFileSync(new URL("../bin/pi.js", import.meta.url), "utf8");

    expect(binContents).toContain('await import("../dist/cli.js");');
    expect(binContents).not.toContain("ensureDependencyPatches");
    expect(binContents).not.toContain("postinstall");
  });
});
