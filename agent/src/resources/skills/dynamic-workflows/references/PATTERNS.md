# Dynamic Workflow Patterns and Use Cases

## Why Use Workflows

When the default harness handles a task, it must plan and execute in the same context window. For many coding tasks this works well, but it breaks down on long-running, massively parallel, or highly structured adversarial tasks.

Separate subagents with isolated context windows combat three failure modes:

- **Agentic laziness:** Stopping before finishing a complex multi-part task and declaring it done after partial progress.
- **Self-preferential bias:** Preferring its own results or findings, especially when asked to verify them.
- **Goal drift:** Gradual loss of fidelity to the original objective across many turns, especially after compaction.

## Common Patterns

### Classify-and-Act

Use a classifier agent to decide on the type of task, then route to different agents or behavior based on the task type. Or use a classifier at the end to determine output quality.

### Fan-Out-and-Synthesize

Split a task into many smaller steps, run an agent on each step, then synthesize results. This is useful when there are many smaller steps, or when each step benefits from its own clean context window so they do not interfere or cross-contaminate. The synthesize step is a barrier: it waits for all fan-out agents, then merges their structured outputs into one result.

### Adversarial Verification

For each spawned agent, run a separate spawned agent to adversarially verify its output against a rubric or criteria.

### Generate-and-Filter

Generate a number of ideas on a topic and then filter them by a rubric or by verification. Deduplicate duplicates and return only the highest quality, tested ideas.

### Tournament

Instead of dividing the work, have agents compete on it. Spawn N agents that each attempt the same task using different approaches. A judging agent then evaluates results in a pairwise fashion using a rubric until there is a winner.

### Loop Until Done

For tasks with an unknown amount of work, loop spawning agents until a stop condition is met (no new findings, no more errors in the logs) instead of a fixed number of passes.

When the same implementer should keep context across passes, keep the first `agent()` result and pass it with `resume` on later fix turns:

```javascript
let build = await agent("Implement the requested change", { label: "build 1", mode: "build" });

for (let iteration = 1; iteration <= 5; iteration++) {
  const review = await agent("Review the current diff and return findings", {
    label: "review " + iteration,
    mode: "review",
    schema: ReviewSchema,
  });

  if (review.findings.length === 0) break;

  build = await agent("Fix findings:\n" + JSON.stringify(review.findings), {
    label: "fix " + iteration,
    mode: "build",
    resume: build,
  });
}
```

Use fresh agents for independent reviewers and use `resume` only for stateful follow-up work. Do not resume one prior result in parallel branches.

## Use Cases

### Migrations and Refactors

Break down the task into a series of steps: callsites, failing tests, modules, etc. Spin off a subagent for every fix in a worktree to make the fix, then have another agent adversarially review, and merge them. Consider telling agents not to use resource-intensive commands so you can maximally parallelize without running out of resources.

### Deep Research

Fan out web searches, fetch sources, adversarially verify their claims, and synthesize a cited report. This pattern also applies beyond web search: compile a status report from Slack context, or research how a feature works by exploring a codebase in-depth.

### Deep Verification

Have one agent identify all factual claims in a report, then spin off a subagent to check each one in detail. A verification agent can also check the source subagent to make sure its source is high quality.

### Sorting and Ranking

For lists of items to sort by a qualitative measurement (support tickets by severity, resumes by fit, etc.), do not sort 1000+ rows in one prompt because quality degrades and it will not fit in context. Instead run a tournament, a pipeline of pairwise-comparison agents, or bucket-rank in parallel then merge. Comparative judgment is more reliable than absolute scoring.

### Memory and Rule Adherence

If there are particular rules the agent misses or struggles with, create a workflow with a list of rules that must be checked by verifier agents — one verifier per rule. Creating a skeptic persona subagent to review the rules themselves helps avoid too many false positives.

The reverse also works: mine recent sessions and code review comments for corrections made repeatedly, cluster them with parallel agents, adversarially verify each candidate, and distill the survivors back into rules.

### Root-Cause Investigation

Debugging works best when coming up with several independent hypotheses and testing them. A single context window can run into self-preferential bias. A workflow can structurally prevent this by spinning up agents to generate hypotheses from disjoint evidence (logs, files, data). Each hypothesis then faces a panel of verifiers and refuters.

This applies beyond code: sales (why did sales drop?), data engineering (why did this pipeline fail?), or any post-mortem exercise.

### Triaging at Scale

A triage workflow classifies each item, deduplicates against what is already tracked, and takes action: attempt the fix or escalate to a human. A useful pattern is quarantine: agents that read untrusted public content are barred from taking high-privilege actions, which are instead done by agents in charge of acting on the information.

Pair triage workflows with `/goal` to set a hard completion requirement and run repeatedly.

### Exploration and Taste

When exploring different approaches to a solution, especially taste-based ones like design or naming, spawn agents to explore a bunch of solutions and give a review agent a rubric for what a good solution looks like. The task is complete when the review agent agrees the criteria are met. Solutions can also be ordered or selected via a tournament.

### Evals

Run lightweight evals by spinning off separate agents in a worktree and then spinning off comparison agents to compare and grade outputs against a rubric. Useful for evaluating and refining a skill against particular criteria.

### Mode and Intelligence Routing

Create a classifier agent tuned to your tasks that decides which mode to use. This helps when the task involves many tool calls and research prior to execution can identify the best mode for the job. For example, a classifier can inspect the codebase and route to `build` or `deep` based on expected complexity.

## When Not to Use Workflows

Workflows are powerful but not needed for every task. They may use significantly more tokens. For regular coding tasks, ask whether it really needs more compute. Most traditional coding tasks do not need a panel of five reviewers.

## Tips

### Prompting

Detailed prompting using the patterns above creates the best results. Workflows are not just for large tasks. Prompt for a "quick workflow" for a fast adversarial review of an assumption.

### Combine with `/goal`

When using workflows that can be repeated (triage, research, verification), pair them with `/goal` to set a hard completion requirement.

### Token Usage Budgets

Set explicit token usage budgets to limit how many tokens a task uses. Prompt with a budget like "use 10k tokens" to set the cap, exposed via the `budget` global.

### Saving and Sharing

Save workflows by pressing `s` in the workflow menu. Check them into `~/.pi/workflows/saved` or distribute them via a skill by putting JavaScript workflow files in the skill folder and referencing them in `SKILL.md`.

### Worktree Isolation

When parallel agents need to edit the same files without conflict, pass `isolation: "worktree"` to `agent()`. Each agent runs in a throwaway git worktree. Results are not auto-merged; the path is surfaced for the caller to inspect.
