import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  answerNote,
  answerQuestionRpc,
  choiceKeys,
  headline,
  questionNotes,
  summarize,
} from "../shared/progress.js";
import { resolveConductorPaths } from "./paths.js";
import { ProgressError, ProgressStore } from "./progress-store.js";

async function store() {
  const root = await mkdtemp(path.join(os.tmpdir(), "progress-"));
  const paths = resolveConductorPaths(root);
  return { root, paths, store: new ProgressStore(paths) };
}

describe("ProgressStore", () => {
  it("builds a run from tickets, questions, and stuck flags", async () => {
    const { store: progress } = await store();
    await progress.record("c1", {
      op: "start",
      title: "Ship",
      text: "2 tickets",
    });
    await progress.record("c1", { op: "ticket", title: "Table", estimate: 60 });
    await progress.record("c1", {
      op: "ticket",
      title: "Filters",
      estimate: 60,
      waitsFor: ["T1"],
    });
    await progress.record(
      "c1",
      {
        op: "ticket",
        id: "T1",
        status: "working",
        stage: "Build",
        note: "Building",
      },
      "w1",
    );
    await progress.record("c1", { op: "ticket", id: "t01", status: "done" });
    await progress.record("c1", {
      op: "ask",
      title: "Spacing",
      text: "Even out?",
      options: [
        { key: "A", label: "Yes" },
        { key: "B", label: "No" },
      ],
      recommend: "A",
    });
    await progress.record("c1", { op: "stuck", text: "CI down", ticket: "T2" });

    const state = await progress.state("c1");
    expect(state?.tickets.map((ticket) => [ticket.id, ticket.status])).toEqual([
      ["T01", "done"],
      ["T02", "not_started"],
    ]);
    expect(state?.tickets[1]?.waitsFor).toEqual(["T01"]);
    expect(state?.ticker?.text).toBe("Building");
    expect(summarize(state!)).toMatchObject({
      percent: 50,
      openQuestions: 1,
      openStuck: 1,
    });
    expect(headline(state!, Date.parse(state!.updatedAt))).toBe(
      "50% · 1 of 2 tickets done, 1 waiting for you, 1 stuck",
    );
  });

  it("refuses to finish with open work and finishes when clear", async () => {
    const { store: progress } = await store();
    await progress.record("c1", { op: "start", title: "Run" });
    await progress.record("c1", { op: "ticket", title: "One" });
    await expect(
      progress.record("c1", { op: "finish", title: "Done" }),
    ).rejects.toBeInstanceOf(ProgressError);
    await progress.record("c1", { op: "ticket", id: "T1", status: "done" });
    await progress.record("c1", { op: "finish", title: "Shipped" });
    expect((await progress.state("c1"))?.finished?.outcome).toBe("Shipped");
    await expect(
      progress.record("c1", { op: "ticket", title: "Late" }),
    ).rejects.toThrow(/finished/);
  });

  it("starts a fresh run but keeps ids unique and ignores damaged lines", async () => {
    const { store: progress, paths } = await store();
    await progress.record("c1", { op: "start", title: "First" });
    await progress.record("c1", { op: "ticket", title: "A" });
    await progress.record("c1", { op: "start", title: "Second" });
    await progress.record("c1", { op: "ticket", title: "B" });
    const file = path.join(paths.conductorDir("c1"), "progress.jsonl");
    await import("node:fs/promises").then((fs) =>
      fs.appendFile(file, "{broken\n"),
    );

    const state = await progress.state("c1");
    expect(state?.title).toBe("Second");
    expect(state?.tickets.map((ticket) => ticket.id)).toEqual(["T02"]);
    expect(await readFile(file, "utf8")).toContain("First");
  });

  it("prints the guide and withdraws questions", async () => {
    const { store: progress } = await store();
    expect(await progress.record("c1", { op: "help" })).toContain(
      "## 10. Finish",
    );
    await progress.record("c1", { op: "start", title: "Run" });
    await progress.record("c1", {
      op: "ask",
      title: "Q",
      text: "?",
      options: [
        { key: "A", label: "x" },
        { key: "B", label: "y" },
      ],
      recommend: "A",
    });
    await progress.record("c1", { op: "withdraw", id: "Q1" });
    expect((await progress.state("c1"))?.questions).toEqual([]);
  });

  it("validates required fields", async () => {
    const { store: progress } = await store();
    await expect(
      progress.record("c1", {
        op: "ask",
        title: "Q",
        text: "?",
        options: [{ key: "A", label: "x" }],
      }),
    ).rejects.toThrow(/options/);
    expect(await progress.record("c1", { op: "show" })).toMatch(
      /No progress run/,
    );
  });

  it("records an answer in the user's own words, without an option", async () => {
    const { store: progress } = await store();
    await progress.record("c1", { op: "start", title: "Run" });
    await progress.record("c1", {
      op: "ask",
      title: "Q",
      text: "?",
      options: [
        { key: "A", label: "x" },
        { key: "B", label: "y" },
      ],
      recommend: "A",
    });
    await expect(
      progress.record("c1", { op: "answer", id: "Q1", words: "  " }),
    ).rejects.toThrow(/choice or words/);
    await progress.record(
      "c1",
      { op: "answer", id: "Q1", words: "Neither, use C" },
      "user",
    );
    expect((await progress.state("c1"))?.questions[0]?.answer).toMatchObject({
      words: "Neither, use C",
    });
    expect(
      (await progress.state("c1"))?.questions[0]?.answer?.choice,
    ).toBeUndefined();
  });
});

describe("answers from the app", () => {
  it("accepts an option, own words, or both, but not neither", () => {
    const base = { conductorId: "c1", id: "Q1" };
    expect(
      answerQuestionRpc.input.safeParse({ ...base, choice: "A" }).success,
    ).toBe(true);
    expect(
      answerQuestionRpc.input.safeParse({ ...base, words: "Do C" }).success,
    ).toBe(true);
    expect(answerQuestionRpc.input.safeParse(base).success).toBe(false);
  });

  it("tells the conductor what the user said", () => {
    expect(answerNote("Q1", "A", undefined)).toContain("answered Q1 option A.");
    expect(answerNote("Q1", "B", "but keep it small")).toContain(
      'option B, adding: "but keep it small"',
    );
    expect(answerNote("Q1", undefined, "Use C")).toContain(
      'in their own words: "Use C"',
    );
  });
});

describe("question routing", () => {
  const ask = (multi = false) => ({
    op: "ask" as const,
    title: "Colors",
    text: "Which themes?",
    options: [
      { key: "A", label: "Dark" },
      { key: "B", label: "Light" },
      { key: "C", label: "Both" },
    ],
    recommend: multi ? "c, a" : "A",
    ...(multi ? { multi } : {}),
  });

  it("records who asked and who answered", async () => {
    const { store: progress } = await store();
    await progress.record("c1", { op: "start", title: "Run" });
    await progress.record("c1", ask(), "w1");
    await progress.record("c1", { op: "answer", id: "Q1", choice: "B" }, "c1");
    const question = (await progress.state("c1"))?.questions[0];
    expect(question?.by).toBe("w1");
    expect(question?.answer).toMatchObject({ choice: "B", by: "c1" });
  });

  it("takes several keys on a multi question, in option order", async () => {
    const { store: progress } = await store();
    await progress.record("c1", { op: "start", title: "Run" });
    await progress.record("c1", ask(true));
    await progress.record("c1", { op: "answer", id: "Q1", choice: "C,A" });
    const question = (await progress.state("c1"))?.questions[0];
    expect(question?.multi).toBe(true);
    expect(question?.recommend).toBe("A,C");
    expect(question?.answer?.choice).toBe("A,C");
    expect(choiceKeys(question?.answer?.choice)).toEqual(["A", "C"]);
  });

  it("refuses several keys on a single question and unknown keys", async () => {
    const { store: progress } = await store();
    await progress.record("c1", { op: "start", title: "Run" });
    await progress.record("c1", ask());
    await expect(
      progress.record("c1", { op: "answer", id: "Q1", choice: "A,B" }),
    ).rejects.toThrow(ProgressError);
    await expect(
      progress.record("c1", { op: "answer", id: "Q1", choice: "Z" }),
    ).rejects.toThrow(ProgressError);
  });

  it("tells the conductor when a worker asks, not when it asks itself", () => {
    const question = {
      id: "Q7",
      title: "Colors",
      text: "Which themes?",
      options: ask().options,
      recommend: "A",
      askedAt: "",
      by: "w1",
    };
    const notes = questionNotes("c1", { op: "ask", by: "w1" }, question);
    expect([...notes.keys()]).toEqual(["c1"]);
    expect(notes.get("c1")).toContain("Agent w1 asked Q7");
    expect(notes.get("c1")).toContain("op=answer id=Q7");
    expect(
      questionNotes("c1", { op: "ask", by: "c1" }, { ...question, by: "c1" })
        .size,
    ).toBe(0);
  });

  it("sends an answer to the asker, and the user's also to the conductor", () => {
    const question = {
      id: "Q7",
      title: "Colors",
      text: "",
      options: ask().options,
      askedAt: "",
      by: "w1",
    };
    const byUser = questionNotes(
      "c1",
      { op: "answer", by: "user", choice: "A" },
      question,
    );
    expect([...byUser.keys()].sort()).toEqual(["c1", "w1"]);
    expect(byUser.get("w1")).toContain("The user answered Q7 option A");
    const byConductor = questionNotes(
      "c1",
      { op: "answer", by: "c1", choice: "A,C" },
      question,
    );
    expect([...byConductor.keys()]).toEqual(["w1"]);
    expect(byConductor.get("w1")).toContain(
      "The conductor answered Q7 options A, C",
    );
    expect(
      questionNotes(
        "c1",
        { op: "answer", by: "c1", choice: "A" },
        { ...question, by: "c1" },
      ).size,
    ).toBe(0);
  });
});

describe("ticket prefix", () => {
  it("takes tickets as AI-01 or a bare number and answers with the prefix", async () => {
    const { store: progress } = await store();
    await progress.setTicketPrefix("c1", "AI");
    expect(await progress.ticketPrefix("c1")).toBe("AI");
    await progress.record("c1", { op: "start", title: "Ship" });
    expect(await progress.record("c1", { op: "ticket", title: "Table" })).toBe(
      "AI-01 added",
    );
    expect(
      await progress.record("c1", {
        op: "ticket",
        title: "Rows",
        waitsFor: ["1"],
      }),
    ).toBe("AI-02 added");
    expect(
      await progress.record("c1", {
        op: "ticket",
        id: "AI-01",
        status: "working",
      }),
    ).toBe("AI-01 working");
    await progress.record("c1", {
      op: "ticker",
      ticket: "ai-1",
      text: "Wiring",
    });
    const state = await progress.state("c1");
    expect(state?.tickets.map((ticket) => ticket.id)).toEqual(["T01", "T02"]);
    expect(state?.tickets[1]?.waitsFor).toEqual(["T01"]);
    const show = await progress.record("c1", { op: "show" });
    expect(show).toContain("AI-01 working");
    expect(show).toContain("(waits AI-01)");
    expect(await progress.record("c1", { op: "help" })).toContain("id=AI-03");
  });
});

describe("dashboard view", () => {
  it("saves search and sort beside the prefix, with defaults", async () => {
    const { store: progress } = await store();
    expect(await progress.view("c1")).toEqual({
      ticketQuery: "",
      ticketSort: "recent",
      feedQuery: "",
      feedScoped: false,
    });
    await progress.setTicketPrefix("c1", "AI");
    const view = {
      ticketQuery: "is:open label:ui",
      ticketSort: "eta" as const,
      feedQuery: "kind:fix",
      feedScoped: true,
    };
    await progress.setView("c1", view);
    expect(await progress.view("c1")).toEqual(view);
    expect(await progress.ticketPrefix("c1")).toBe("AI");
  });
});

describe("ticket links", () => {
  it("takes #ids and numbers, and refuses loops with a readable reason", async () => {
    const { store: progress } = await store();
    await progress.setTicketPrefix("c1", "AI");
    await progress.record("c1", { op: "start", title: "Ship" });
    await progress.record("c1", { op: "ticket", title: "Epic" });
    await progress.record("c1", {
      op: "ticket",
      title: "Part",
      parent: "#AI-01",
    });
    await progress.record("c1", {
      op: "ticket",
      title: "Later",
      waitsFor: ["#2", "ai-1"],
      related: ["AI-02"],
    });
    const state = await progress.state("c1");
    expect(state?.tickets[1]?.parent).toBe("T01");
    expect(state?.tickets[2]?.waitsFor).toEqual(["T02", "T01"]);
    await expect(
      progress.record("c1", { op: "ticket", id: "1", waitsFor: ["3"] }),
    ).rejects.toThrow(
      "waitsFor AI-03 would loop: AI-03 already waits for AI-01",
    );
    await expect(
      progress.record("c1", { op: "ticket", title: "X", waitsFor: ["9"] }),
    ).rejects.toThrow("waitsFor: no ticket AI-09 in this run.");
    expect(await progress.record("c1", { op: "show" })).toContain(
      "AI-02 not_started Part (sub-task of AI-01)",
    );
  });
});
