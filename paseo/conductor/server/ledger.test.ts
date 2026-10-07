import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { LedgerStore } from "./ledger.js";

describe("LedgerStore", () => {
  it("returns empty ledger when file is missing and round-trips records", async () => {
    const store = new LedgerStore(
      path.join(
        await mkdtemp(path.join(os.tmpdir(), "conductor-")),
        "nested",
        "ledger.json",
      ),
    );
    expect(await store.load()).toEqual({});
    const workers = {
      w1: {
        conductorId: "c1",
        title: "Docs",
        running: true,
        runningSince: "2026-10-07T10:00:00.000Z",
        stallReportedAt: null,
        permissions: {},
      },
    };
    await store.save(workers);
    expect(await store.load()).toEqual(workers);
  });
});
