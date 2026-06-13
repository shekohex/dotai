---
name: gsd:new-milestone
description: Start a new milestone cycle — update PROJECT.md and route to requirements
argument-hint: "[milestone name, e.g., 'v1.1 Notifications']"
allowed-tools:
  - read
  - write
  - bash
  - subagent
  - ask_user_question
---

<local_runtime>
Local runtime mapping for this repo:

- `Task(...)` => use `subagent` tool with matching local GSD mode.
- `ask_user_question(...)` => use `ask_user_question` when structured UX helps, else ask directly in chat.
- `gsd-sdk query ...` => perform equivalent work natively with local files, repo inspection, bundled prompts, and local tools. If exact legacy helper behavior is useful and no native helper exists yet, use bundled `node {{GSD_BUNDLE_DIR}}/bin/gsd-tools.cjs ...` as local compatibility utility.
- `{{GSD_BUNDLE_DIR}}` paths point at bundled GSD resources in this repo.

</local_runtime>

<objective>
Start a new milestone: questioning → research (optional) → requirements → roadmap.

Brownfield equivalent of new-project. Project exists, PROJECT.md has history. Gathers "what's next", updates PROJECT.md, then runs requirements → roadmap cycle.

**Creates/Updates:**

- `.planning/PROJECT.md` — updated with new milestone goals
- `.planning/research/` — domain research (optional, NEW features only)
- `.planning/REQUIREMENTS.md` — scoped requirements for this milestone
- `.planning/ROADMAP.md` — phase structure (continues numbering)
- `.planning/STATE.md` — reset for new milestone

**After:** `/gsd plan-phase [N]` to start execution.
</objective>

<execution_context>
@{{GSD_BUNDLE_DIR}}/workflows/new-milestone.md
@{{GSD_BUNDLE_DIR}}/references/questioning.md
@{{GSD_BUNDLE_DIR}}/references/ui-brand.md
@{{GSD_BUNDLE_DIR}}/templates/project.md
@{{GSD_BUNDLE_DIR}}/templates/requirements.md
</execution_context>

<context>
Milestone name: $ARGUMENTS (optional - will prompt if not provided)

Project and milestone context files are resolved inside the workflow (`init new-milestone`) and delegated via `<files_to_read>` blocks where subagents are used.
</context>

<process>
Execute the new-milestone workflow from @{{GSD_BUNDLE_DIR}}/workflows/new-milestone.md end-to-end.
Preserve all workflow gates (validation, questioning, research, requirements, roadmap approval, commits).
</process>
