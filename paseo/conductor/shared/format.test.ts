import { describe, expect, it } from "vitest";

import { formatTicketTime, formatTicketTimeShort } from "./format.js";

describe("formatTicketTime", () => {
  it("shows time worked and what is left of the estimate", () => {
    expect(formatTicketTime(86, 240, false)).toEqual({
      text: "1h 26m worked · ETA ~2h 34m left",
      over: false,
    });
    expect(formatTicketTime(30, undefined, false).text).toBe("30m worked");
  });

  it("flags work past the estimate, and sums up settled tickets", () => {
    expect(formatTicketTime(80, 60, false)).toEqual({
      text: "1h 20m worked · over the 1h estimate by 20m",
      over: true,
    });
    expect(formatTicketTime(86, 240, true).text).toBe("Took 1h 26m of 4h");
  });
});

describe("formatTicketTimeShort", () => {
  it("fits worked, estimate, and ETA on one row line", () => {
    expect(formatTicketTimeShort(50, 330, false)).toEqual({
      text: "50m of 5h 30m · ETA ~4h 40m",
      over: false,
    });
    expect(formatTicketTimeShort(80, 60, false)).toEqual({
      text: "1h 20m of 1h · over by 20m",
      over: true,
    });
    expect(formatTicketTimeShort(30, undefined, false).text).toBe("30m worked");
    expect(formatTicketTimeShort(86, 240, true).text).toBe("Took 1h 26m of 4h");
  });
});
