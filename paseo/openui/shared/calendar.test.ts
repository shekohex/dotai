import { describe, expect, it } from "vitest";
import { addMonths, asRange, covers, monthGrid, parseIso, pickDay, rowsOnDates, startMonth } from "./calendar";

describe("calendar", () => {
  it("rejects dates that do not exist", () => {
    expect(parseIso("2026-02-29")).toBeNull();
    expect(parseIso("2028-02-29")).toEqual({ year: 2028, month: 2, day: 29 });
    expect(parseIso("nope")).toBeNull();
  });

  it("rolls months across years", () => {
    expect(addMonths(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
    expect(addMonths(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
    expect(addMonths(2026, 3, 14)).toEqual({ year: 2027, month: 5 });
  });

  it("lays a month out in whole weeks", () => {
    const grid = monthGrid(2026, 3);
    expect(grid.every((week) => week.length === 7)).toBe(true);
    expect(grid[0]?.indexOf("2026-03-01")).toBe(0);
    expect(grid.flat().filter(Boolean)).toHaveLength(31);
    expect(monthGrid(2026, 3, 1)[0]?.indexOf("2026-03-01")).toBe(6);
  });

  it("picks a single day or builds a range in two taps", () => {
    expect(pickDay(null, "2026-03-05", false)).toBe("2026-03-05");
    expect(pickDay([], "2026-03-05", true)).toEqual(["2026-03-05"]);
    expect(pickDay(["2026-03-05"], "2026-03-02", true)).toEqual(["2026-03-02", "2026-03-05"]);
    expect(pickDay(["2026-03-02", "2026-03-05"], "2026-03-09", true)).toEqual(["2026-03-09"]);
  });

  it("knows which days a value covers", () => {
    expect(covers(["2026-03-02", "2026-03-05"], "2026-03-04")).toBe(true);
    expect(covers(["2026-03-02", "2026-03-05"], "2026-03-06")).toBe(false);
    expect(covers("2026-03-02", "2026-03-02")).toBe(true);
    expect(asRange(["2026-03-09", "bad", "2026-03-01"])).toEqual(["2026-03-01", "2026-03-09"]);
  });

  it("filters rows by date", () => {
    const rows = [{ at: "2026-03-01" }, { at: "2026-03-04T10:00:00Z" }, { at: "2026-03-09" }];
    expect(rowsOnDates(rows, "at", ["2026-03-02", "2026-03-09"])).toEqual([rows[1], rows[2]]);
    expect(rowsOnDates(rows, "at", "2026-03-01")).toEqual([rows[0]]);
    expect(rowsOnDates(rows, "at", null)).toEqual(rows);
    expect(rowsOnDates(["2026-03-02", "2026-04-01"], "", ["2026-03-01", "2026-03-31"])).toEqual(["2026-03-02"]);
  });

  it("opens on a sensible month", () => {
    const now = { year: 2026, month: 10 };
    expect(startMonth(["2026-03-05"], null, null, now)).toMatchObject({ year: 2026, month: 3 });
    expect(startMonth(null, "2020-01-01", null, now)).toBe(now);
    expect(startMonth(null, "2027-02-01", null, now)).toMatchObject({ year: 2027, month: 2 });
    expect(startMonth(null, null, "2026-05-31", now)).toMatchObject({ year: 2026, month: 5 });
  });
});
