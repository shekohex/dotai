import { describe, expect, it } from "vitest";
import { sliderFraction, sliderValue } from "./slider";

describe("slider", () => {
  it("maps a fraction to a stepped value", () => {
    expect(sliderValue(0, 1, 50, 1)).toBe(1);
    expect(sliderValue(1, 1, 50, 1)).toBe(50);
    expect(sliderValue(0.5, 0, 100, 10)).toBe(50);
    expect(sliderValue(0.33, 0, 100, 5)).toBe(35);
  });

  it("clamps outside the track and keeps decimal steps exact", () => {
    expect(sliderValue(-2, 0, 10, 1)).toBe(0);
    expect(sliderValue(3, 0, 10, 1)).toBe(10);
    expect(sliderValue(0.3, 0, 1, 0.1)).toBe(0.3);
    expect(sliderValue(0.5, 0, 10, 3)).toBe(6);
  });

  it("finds the position of a value", () => {
    expect(sliderFraction(25, 0, 100)).toBe(0.25);
    expect(sliderFraction(500, 0, 100)).toBe(1);
    expect(sliderFraction(5, 5, 5)).toBe(0);
  });
});
