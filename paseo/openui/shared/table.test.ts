import { describe, expect, it } from "vitest";
import { compareCells, matchOptions, pageCount, pageRows, searchRows, sortRows, toggleOption } from "./table";

describe("table", () => {
  it("sorts numbers by value and text naturally", () => {
    const rows = [["b", 10], ["a", 9], ["c", 100]];
    expect(sortRows(rows, 1, "asc").map((row) => row[1])).toEqual([9, 10, 100]);
    expect(sortRows(rows, 1, "desc").map((row) => row[1])).toEqual([100, 10, 9]);
    expect(sortRows(rows, 0, "asc").map((row) => row[0])).toEqual(["a", "b", "c"]);
    expect(sortRows(rows, null, "asc")).toBe(rows);
    expect(compareCells("item 2", "item 10")).toBeLessThan(0);
    expect(compareCells("12 kB", "9 kB")).toBeGreaterThan(0);
  });

  it("searches every cell", () => {
    const rows = [["zod", 13], ["yup", 40]];
    expect(searchRows(rows, "ZO")).toEqual([rows[0]]);
    expect(searchRows(rows, "40")).toEqual([rows[1]]);
    expect(searchRows(rows, "  ")).toBe(rows);
  });

  it("pages and clamps", () => {
    const rows = Array.from({ length: 25 }, (_, index) => index);
    expect(pageCount(25, 10)).toBe(3);
    expect(pageCount(0, 10)).toBe(1);
    expect(pageRows(rows, 2, 10)).toEqual([20, 21, 22, 23, 24]);
    expect(pageRows(rows, 9, 10)).toEqual([20, 21, 22, 23, 24]);
    expect(pageRows(rows, -1, 10)).toHaveLength(10);
  });

  it("narrows and toggles options", () => {
    expect(matchOptions(["Cairo", "Dubai", "Oslo"], "OS")).toEqual(["Oslo"]);
    expect(matchOptions(["Cairo"], "")).toEqual(["Cairo"]);
    expect(toggleOption(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleOption(["a", "b"], "a")).toEqual(["b"]);
  });
});
