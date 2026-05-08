# Context Budget

Use for `/gsd execute-phase` orchestration.

Budget split:

- orchestrator: keep near 15% budget
- each delegated executor: assume fresh context window
- verifier: fresh focused context on merged results

Rules:

1. Orchestrator reads indexes, helper outputs, step contracts, and only plan files needed for dispatch decisions.
2. Do not inline entire plan bodies for all plans into orchestrator reasoning.
3. Delegate actual plan execution to executor workers whenever not in `--interactive` mode.
4. After each wave, compress state into plan ids, statuses, summaries, checkpoint/UAT outcomes, and gate results.
5. If context pressure rises, prefer re-reading canonical helper output over carrying stale paraphrases.
