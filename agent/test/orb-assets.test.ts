import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { discoverSkillPaths } from "../src/extensions/bundled-resources.ts";

const orbResources = "macos/PiLive/Sources/PiLive/Resources/Orbs";
const skillDirectory = "src/resources/skills/generating-orb-sheets";

type OrbSequence = { frames?: number[]; fallbackState?: string; reducedMotionFrame?: number };
type OrbPack = {
  id: string;
  sheet: string;
  columns: number;
  rows: number;
  states: Record<string, OrbSequence>;
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function pngDimensions(path: string): { width: number; height: number } {
  const data = readFileSync(path);
  expect(data.subarray(1, 4).toString("ascii")).toBe("PNG");
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

function referencedFrames(pack: OrbPack): Set<number> {
  return new Set(Object.values(pack.states).flatMap((sequence) => sequence.frames ?? []));
}

describe("Pi Live orb assets", () => {
  it("bundles reusable generation skill and deterministic tools", () => {
    const skillPath = discoverSkillPaths().find((path) =>
      path.endsWith("/generating-orb-sheets/SKILL.md"),
    );

    expect(skillPath).toBeDefined();
    expect(readFileSync(skillPath!, "utf8").split("\n").length).toBeLessThanOrEqual(100);
    for (const path of [
      join(dirname(skillPath!), "scripts", "orb_sheet.py"),
      join(dirname(skillPath!), "scripts", "requirements.txt"),
      join(dirname(skillPath!), "templates", "miss-minutes-pack.json"),
    ]) {
      expect(existsSync(path)).toBe(true);
    }
  });

  it("defines eight frames for every state in an eight-by-twelve sheet", () => {
    const pack = readJson<OrbPack>(join(skillDirectory, "templates", "miss-minutes-pack.json"));
    const frames = referencedFrames(pack);

    expect(pack.columns).toBe(8);
    expect(pack.rows).toBe(12);
    expect(frames.size).toBe(96);
    expect([...frames].toSorted((left, right) => left - right)).toEqual(
      Array.from({ length: 96 }, (_, index) => index),
    );
    for (const [row, sequence] of Object.values(pack.states).entries()) {
      expect(new Set(sequence.frames)).toEqual(
        new Set(Array.from({ length: 8 }, (_, column) => row * 8 + column)),
      );
      expect(sequence.frames).toContain(sequence.reducedMotionFrame);
    }
    expect(pack.states.listening?.frames).toEqual([16, 17, 18, 19, 20, 20, 21, 22, 23, 23]);
  });

  it("keeps runtime rendering grid-driven and free of chroma-key logic", () => {
    const renderer = readFileSync("macos/PiLive/Sources/PiLive/OrbRenderer.swift", "utf8");
    const catalog = readFileSync("macos/PiLive/Sources/PiLive/OrbCatalog.swift", "utf8");

    expect(renderer).toContain("sheet.width / pack.columns");
    expect(renderer).toContain("sheet.height / pack.rows");
    expect(renderer).not.toMatch(/FF00FF|chroma|columns\s*[/%]\s*4|rows\s*[/%]\s*4/iu);
    expect(catalog).toContain("pack.columns * pack.rows <= 1_024");
    expect(catalog).not.toContain("packs.count >= 2");
  });

  it("resolves every current catalog sheet and frame within its declared grid", () => {
    const catalog = readJson<{ packs: OrbPack[] }>(join(orbResources, "catalog.json"));
    const template = readJson<OrbPack>(join(skillDirectory, "templates", "miss-minutes-pack.json"));

    expect(catalog.packs.length).toBeGreaterThan(0);
    expect(catalog.packs.find((pack) => pack.id === template.id)).toEqual(template);
    for (const pack of catalog.packs) {
      const sheetPath = join(orbResources, pack.sheet);
      expect(existsSync(sheetPath)).toBe(true);
      const dimensions = pngDimensions(sheetPath);
      expect(dimensions.width % pack.columns).toBe(0);
      expect(dimensions.height % pack.rows).toBe(0);
      const capacity = pack.columns * pack.rows;
      expect([...referencedFrames(pack)].every((frame) => frame >= 0 && frame < capacity)).toBe(
        true,
      );
    }
  });
});
