---
type: prompt
name: gsd:milestone-summary
description: Generate a comprehensive project summary from milestone artifacts for team onboarding and review
argument-hint: "[version]"
allowed-tools:
  - read
  - write
  - bash
---

<local_runtime>
Local runtime mapping for this repo:

- `Task(...)` => use `subagent` tool with matching local GSD mode.
- `ask_user_question(...)` => use `ask_user_question` when structured UX helps, else ask directly in chat.
- `gsd-sdk query ...` => perform equivalent work natively with local files, repo inspection, bundled prompts, and local tools. If exact legacy helper behavior is useful and no native helper exists yet, use bundled `node {{GSD_BUNDLE_DIR}}/bin/gsd-tools.cjs ...` as local compatibility utility.
- `{{GSD_BUNDLE_DIR}}` paths point at bundled GSD resources in this repo.

</local_runtime>

<flags>

- `--text` — Use plain-text follow-up Q&A instead of structured question forms.

</flags>

<objective>
Generate a structured milestone summary for team onboarding and project review. Reads completed milestone artifacts (ROADMAP, REQUIREMENTS, CONTEXT, SUMMARY, VERIFICATION files) and produces a human-friendly overview of what was built, how, and why.

Purpose: Enable new team members to understand a completed project by reading one document and asking follow-up questions.
Output: MILESTONE_SUMMARY written to `.planning/reports/`, presented inline, optional interactive Q&A.
</objective>

<execution_context>
@{{GSD_BUNDLE_DIR}}/workflows/milestone-summary.md
</execution_context>

<context>
**Project files:**
- `.planning/ROADMAP.md`
- `.planning/PROJECT.md`
- `.planning/STATE.md`
- `.planning/RETROSPECTIVE.md`
- `.planning/milestones/v{version}-ROADMAP.md` (if archived)
- `.planning/milestones/v{version}-REQUIREMENTS.md` (if archived)
- `.planning/milestones/v{version}-phases/` (if archived by `complete-milestone`)
- `.planning/phases/*-*/` (SUMMARY.md, VERIFICATION.md, CONTEXT.md, RESEARCH.md)

**User input:**

- Version: $ARGUMENTS (optional — defaults to current/latest milestone)
  </context>

<process>
Read and execute the milestone-summary workflow from @{{GSD_BUNDLE_DIR}}/workflows/milestone-summary.md end-to-end.
</process>

<success_criteria>

- Milestone version resolved (from args, STATE.md, or archive scan)
- All available artifacts read (ROADMAP, REQUIREMENTS, CONTEXT, SUMMARY, VERIFICATION, RESEARCH, RETROSPECTIVE)
- Summary document written to `.planning/reports/MILESTONE_SUMMARY-v{version}.md`
- All 7 sections generated (Overview, Architecture, Phases, Decisions, Requirements, Tech Debt, Getting Started)
- Summary presented inline to user
- Interactive Q&A offered
- `STATE.md` left unchanged unless user-visible final output explicitly includes a coordinated state update
  </success_criteria>
