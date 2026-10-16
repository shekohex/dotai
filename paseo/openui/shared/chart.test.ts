import { describe, expect, it } from "vitest";
import { formatCompact, labelIndices, luminance, nearestIndex, niceScale, pieAngles, pieHit, pointX, segment, stackValues } from "./chart";

describe("chart geometry", () => {
  it("builds a rotated box for a diagonal line", () => {
    const s = segment(0, 0, 3, 4, 2);
    expect(s.width).toBeCloseTo(5);
    expect(s.left).toBeCloseTo(1.5 - 2.5);
    expect(s.top).toBeCloseTo(2 - 1);
    expect(s.rotate).toBeCloseTo(Math.atan2(4, 3));
  });

  it("rounds the axis to nice ticks", () => {
    expect(niceScale(0, 97, 4)).toEqual({ min: 0, max: 100, ticks: [0, 50, 100] });
    expect(niceScale(0, 97, 8).ticks).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceScale(3, 3).ticks.length).toBeGreaterThan(1);
    expect(niceScale(0, 0).max).toBe(1);
  });

  it("formats numbers compactly", () => {
    expect(formatCompact(1200)).toBe("1200");
    expect(formatCompact(12000)).toBe("12k");
    expect(formatCompact(2500000)).toBe("2.5M");
    expect(formatCompact(0.456)).toBe("0.46");
  });

  it("places points and finds the nearest one", () => {
    expect(pointX(0, 5, 100)).toBe(0);
    expect(pointX(4, 5, 100)).toBe(100);
    expect(pointX(0, 1, 100)).toBe(50);
    expect(nearestIndex(60, 5, 100)).toBe(2);
    expect(nearestIndex(-20, 5, 100)).toBe(0);
    expect(nearestIndex(999, 5, 100)).toBe(4);
  });

  it("splits a pie by value and hit-tests it", () => {
    const slices = pieAngles([1, 1, 2]);
    expect(slices.map((s) => s.fraction)).toEqual([0.25, 0.25, 0.5]);
    expect(slices[0]?.start).toBeCloseTo(-Math.PI / 2);
    expect(slices[2]?.end).toBeCloseTo(-Math.PI / 2 + Math.PI * 2);
    expect(pieHit(10, -10, 0, 50, slices)).toBe(0); // up and right: 12 to 3 o'clock
    expect(pieHit(1, 10, 0, 50, slices)).toBe(1); // down and slightly right: 3 to 6 o'clock
    expect(pieHit(-10, 0, 0, 50, slices)).toBe(2);
    expect(pieHit(0, 0, 5, 50, slices)).toBe(-1);
    expect(pieAngles([0, 0]).every((s) => s.fraction === 0)).toBe(true);
  });

  it("stacks series cumulatively", () => {
    expect(stackValues([[1, 2], [3, 4]])).toEqual([
      [{ low: 0, high: 1 }, { low: 0, high: 2 }],
      [{ low: 1, high: 4 }, { low: 2, high: 6 }],
    ]);
  });

  it("picks evenly spaced labels including the ends", () => {
    expect(labelIndices(3, 5)).toEqual([0, 1, 2]);
    const picked = labelIndices(31, 5);
    expect(picked[0]).toBe(0);
    expect(picked[picked.length - 1]).toBe(30);
    expect(picked).toHaveLength(5);
  });

  it("tells dark from light", () => {
    expect(luminance("#000000")).toBe(0);
    expect(luminance("#ffffff")).toBeCloseTo(1);
    expect(luminance("rgb(0,0,0)")).toBe(0);
  });
});

import { mixColor, parseTime, treemap } from "./chart";

describe("treemap and colors", () => {
  it("tiles the area by value", () => {
    const rects = treemap([6, 6, 4, 3, 2, 2, 1], 600, 400);
    const area = rects.reduce((sum, r) => sum + r.w * r.h, 0);
    expect(area).toBeCloseTo(600 * 400, 3);
    expect(rects[0]!.w * rects[0]!.h).toBeCloseTo((6 / 24) * 240000, 3);
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(-1e-6);
      expect(r.x + r.w).toBeLessThanOrEqual(600 + 1e-6);
      expect(r.y + r.h).toBeLessThanOrEqual(400 + 1e-6);
    }
  });

  it("gives zero and negative values no area", () => {
    const rects = treemap([5, 0, -3, 5], 100, 100);
    expect(rects[1]).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    expect(rects[2]!.w).toBe(0);
    expect(treemap([0, 0], 100, 100).every((r) => r.w === 0)).toBe(true);
  });

  it("mixes colors", () => {
    expect(mixColor("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixColor("#102030", "#ffffff", 0)).toBe("#102030");
    expect(mixColor("rgb(0,0,0)", "#ff0000", 0.3)).toBe("#ff0000");
  });

  it("parses times", () => {
    expect(parseTime(5)).toBe(5);
    expect(parseTime("12")).toBe(12);
    expect(parseTime("2026-10-16")).toBe(Date.parse("2026-10-16"));
    expect(Number.isNaN(parseTime("soon"))).toBe(true);
  });
});

import { boxStats, calendarCell, histogram, linearFit, percentOfTotal, radarPoint, waterfall } from "./chart";

describe("distribution and flow helpers", () => {
  it("bins values and keeps the maximum in the last bin", () => {
    const h = histogram([1, 2, 2, 3, 3, 3, 10], 3);
    expect(h.counts).toEqual([6, 0, 1]);
    expect(h.counts.reduce((a, b) => a + b, 0)).toBe(7);
    expect(histogram([], 3).counts).toEqual([0]);
    expect(histogram([5, 5, 5]).counts.reduce((a, b) => a + b, 0)).toBe(3);
  });
  it("computes box stats with outliers", () => {
    const stats = boxStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 100])!;
    expect(stats.median).toBe(5.5);
    expect(stats.q1).toBe(3.25);
    expect(stats.outliers).toEqual([100]);
    expect(stats.max).toBe(9);
    expect(boxStats([])).toBeNull();
  });
  it("fits a line", () => {
    const fit = linearFit([[0, 1], [1, 3], [2, 5]])!;
    expect(fit.slope).toBeCloseTo(2);
    expect(fit.intercept).toBeCloseTo(1);
    expect(linearFit([[1, 1], [1, 2]])).toBeNull();
  });
  it("chains waterfall bars", () => {
    expect(waterfall([{ value: 100, total: false }, { value: -30, total: false }, { value: 0, total: true }, { value: 20, total: false }])).toEqual([
      { start: 0, end: 100, total: false },
      { start: 100, end: 70, total: false },
      { start: 0, end: 70, total: true },
      { start: 70, end: 90, total: false },
    ]);
  });
  it("places calendar days monday-first", () => {
    const monday = Date.parse("2026-03-02");
    expect(calendarCell(monday, monday)).toEqual({ week: 0, row: 0 });
    expect(calendarCell(Date.parse("2026-03-08"), monday)).toEqual({ week: 0, row: 6 });
    expect(calendarCell(Date.parse("2026-03-09"), monday)).toEqual({ week: 1, row: 0 });
    expect(calendarCell(Date.parse("2026-03-09"), Date.parse("2026-03-05"))).toEqual({ week: 1, row: 0 });
  });
  it("places radar corners clockwise from the top", () => {
    const top = radarPoint(0, 4, 10);
    expect(top.x).toBeCloseTo(0);
    expect(top.y).toBeCloseTo(-10);
    expect(radarPoint(1, 4, 10).x).toBeCloseTo(10);
  });
  it("normalizes to percent", () => {
    expect(percentOfTotal([[1, 0], [3, 0]])).toEqual([[25, 0], [75, 0]]);
  });
});
