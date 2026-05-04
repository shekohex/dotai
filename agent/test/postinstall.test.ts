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
});
