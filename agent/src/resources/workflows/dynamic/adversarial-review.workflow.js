export const meta = {
  name: "adversarial_review",
  description: "Adversarial review: findings cross-checked by independent skeptics",
  phases: [{ title: "Investigate" }, { title: "Refute" }, { title: "Consensus" }],
};

const task = (args && args.task) || "";
const reviewers = (args && args.reviewers) || 4;
const threshold = (args && args.threshold) || 0.5;

phase("Investigate");
const investigation = await agent(
  "Investigate the following and list concrete, individually-checkable findings:\n" + task,
  {
    label: "investigate",
    mode: "review",
    schema: {
      type: "object",
      properties: { findings: { type: "array", items: { type: "string" } } },
      required: ["findings"],
    },
  },
);
const findings = investigation.findings || [];

phase("Refute");
const judged = await parallel(
  findings.map(
    (f, i) => () =>
      parallel(
        Array.from(
          { length: reviewers },
          (_, r) => () =>
            agent(
              "You are a skeptical reviewer. Try to REFUTE this finding for the task below. " +
                "Default to real=false when uncertain. Investigate with the available tools if needed.\n\n" +
                "TASK: " +
                task +
                "\nFINDING: " +
                f,
              {
                label: "refute " + (i + 1) + "." + (r + 1),
                mode: "cheap-review",
                schema: {
                  type: "object",
                  properties: { real: { type: "boolean" }, reason: { type: "string" } },
                  required: ["real"],
                },
              },
            ),
        ),
      ).then((votes) => {
        const valid = votes.filter(Boolean);
        const realCount = valid.filter((v) => v && v.real).length;
        const ratio = valid.length ? realCount / valid.length : 0;
        return {
          finding: f,
          realVotes: realCount,
          totalVotes: valid.length,
          survives: ratio >= threshold,
        };
      }),
  ),
);

const survivors = judged.filter((j) => j && j.survives);

phase("Consensus");
const report = await agent(
  "Write a final review report. Include ONLY the findings that survived adversarial review (listed below), " +
    "each with a short justification. Note how many were discarded.\n\n" +
    "SURVIVING FINDINGS JSON:\n" +
    JSON.stringify(survivors),
  { label: "consensus", mode: "review" },
);

return { total: findings.length, survivors, report };
