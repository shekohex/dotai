---
name: skill-creator
description: Create or improve agent skills. Use for skill authoring, skill evaluations, or description-trigger tuning.
---

# Skill Creator

Create skills that contribute task-specific knowledge, tool contracts, and useful decision boundaries. Preserve existing names, resources, and invocation settings unless the requested change calls for adjusting them.

## Author or edit

1. Infer the desired outcome, triggers, constraints, and deliverables from the conversation and current files. Ask only for missing information that changes the result.
2. Write a short description stating the capability and when it applies. Include a near-miss exclusion only when it prevents likely misrouting. Avoid synonym lists, broad keyword triggers, and pressure to invoke.
3. Keep shared purpose, essential constraints, completion criteria, and routing in `SKILL.md`. Move substantial branch-specific procedures to linked references, with a clear condition for reading each. A simple skill can stay self-contained.
4. Preserve non-obvious command syntax, schemas, ordering requirements, and authorization boundaries. Describe outcomes and decision criteria for flexible work instead of prescribing every action.
5. Reuse scripts when deterministic or repeated mechanics justify them. Inspect callers before moving or deleting resources. Do not add placeholders, copied manuals, or speculative helpers.
6. Validate frontmatter, local links, and changed scripts. Check realistic triggering and execution cases at a depth proportionate to the change. Fix demonstrated gaps and stop once acceptance criteria are met.

Keep mandatory process proportional to correctness and risk. An existing authorization stays valid; ordinary drafts, local edits, and checks should not acquire extra approval gates. Define both completion and when missing input actually blocks further work. Avoid certainty targets such as "100% confident" and repeated tests after unchanged results.

Use [writing-great-skills](../writing-great-skills/SKILL.md) when a larger redesign needs shared authoring vocabulary. Consider all models and hosts expected to use the skill; do not encode assumed weaknesses of one old model as universal rules.

## Optional branches

- **Behavioral evaluation or benchmarking:** read [evaluation.md](references/evaluation.md) for matched candidate/baseline runs, grading, aggregation, and the existing review viewer. Use observable outcomes; syntax validation alone does not prove behavioral improvement.
- **Description-trigger tuning:** read [description-optimization.md](references/description-optimization.md) when routing needs measurement. Requires the `claude` CLI; do not assume it evaluates other hosts or models.
- **Blind comparison:** read [agents/comparator.md](agents/comparator.md) and [agents/analyzer.md](agents/analyzer.md) when an independent comparison is requested and agents are available.
- **Structured evaluation files:** read [references/schemas.md](references/schemas.md) when producing inputs for bundled evaluation tools.
- **Packaging:** when a distributable archive is requested, run `python -m scripts.package_skill <path/to/skill-folder>` from this skill directory. An in-place edit does not require packaging.

Use isolated output directories for evaluations. If a browser is unavailable, the bundled viewer supports `--static <output_path>`. If independent agents or timing data are unavailable, disclose that limit instead of fabricating results. User silence or blank review fields are not approval.

Deliver the changed skill, validation results, and material limitations. Do not imply that an unmeasured revision improved model performance.
