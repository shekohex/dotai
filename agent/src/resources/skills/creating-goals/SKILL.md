---
name: creating-goals
description: >-
  Create or update durable agent goals by turning user intent into a polished,
  outcome-first closed feedback loop prompt. Use when the user asks to create,
  update, write, refine, or install a goal, or mentions goal prompts, closed
  feedback loops, goal tool usage, or goal instructions.
---

# Creating Goals

Use this skill to write goal prompts that another agent can execute autonomously with a closed feedback loop.

## Required Reference

Before drafting the goal prompt, read `references/PROMPT_GUIDE_GPT5_5.md` and apply its guidance on outcome-first prompts, validation loops, formatting, phase handling, and stop rules.

## Workflow

1. Read relevant codebase files, docs, and prior context that can answer open questions about the goal.
2. Ask the user for clarification before drafting when the goal is still ambiguous after inspection.
3. Run `./scripts/draft-goal.sh <short-slug>` on Unix or `./scripts/draft-goal.ps1 <short-slug>` on PowerShell to create the temporary draft file and get the Plannotator annotation command.
4. The file has YAML frontmatter plus a prompt template. Fill in frontmatter deterministically, then write the full goal prompt from the user's intent, discovered context, and the prompt guide. Present that file path for review before using any goal tool.
5. If the user requests changes, update the temporary file and present the same file path again. Repeat until explicit approval.
6. If the user approves, call the `goal` tool to create or update the goal using `objectiveFile` with the absolute path to the approved prompt file. Prefer `objectiveFile` over inline `objective` so the file content is used exactly as written and the prompt is not duplicated into the tool call. If the `goal` tool is unavailable, ask the user to run `/goal on`.
7. After goal tool success, delete the temporary file, then report the goal created or updated and any identifier returned by the tool.

## Draft Script

Use the script from the skill directory:

Unix: `./scripts/draft-goal.sh <short-slug>`

PowerShell: `./scripts/draft-goal.ps1 <short-slug>`

The script creates `/tmp/goal-prompt-<short-slug>.md` or the platform temp equivalent. It prints the draft file path and the full `/plannotator annotate <draft-path>` command to show the user. It does not overwrite an existing draft.

## Frontmatter

Every goal prompt draft should start with YAML frontmatter so `/goal workflow` can parse execution inputs deterministically from either `objectiveFile` or inline objective text.

Required keys:

- `successCriteria`: observable criteria proving the goal is complete end to end.
- `constraints`: side-effect limits, non-goals, approval rules, and project constraints.
- `verificationCommands`: concrete commands/checks to run when applicable. Use an empty list when no command is known.

Shape:

```yaml
---
successCriteria:
  - "User-visible behavior or repository state that must be true."
constraints:
  - "Constraint, non-goal, side-effect limit, or approval requirement."
verificationCommands:
  - "npm run typecheck"
  - "npm test"
---
```

Rules:

- Keep frontmatter factual and deterministic. Do not include prose paragraphs there.
- Quote every YAML list item with double quotes. This avoids parse errors when values contain reserved characters such as backticks, colons, braces, brackets, hashes, or angle brackets.
- Mirror the same information in the body when it helps the executing agent, but treat frontmatter as the machine-readable source of truth for workflow args.
- If validation requires screenshots, logs, manual QA, or external evidence instead of commands, put that requirement under `successCriteria` or `constraints`, not `verificationCommands`.
- Do not add iteration caps, token limits, or time estimates unless the user explicitly asks.

## Goal Prompt Requirements

The prompt should define:

- role and operating context
- user-visible outcome
- success criteria
- constraints and side-effect limits
- evidence and citation rules when applicable
- tool-use rules and validation commands when applicable
- proof collection rules such as screenshots, logs, full end-to-end tests, or command output when applicable
- closed feedback loop rules for inspect, act, verify, collect proof, and decide whether to continue
- stopping conditions for success, blockers, missing evidence, and user approval needs
- loophole detection that calls out any requirement gap that could let the agent finish early without proving success
- self-reflection checks for confidence, ergonomics, optimization, and factual completeness
- final output shape

Do not add token limits, turn limits, time estimates, or artificial iteration caps unless the user explicitly asks.

## Closed Feedback Loop Pattern

Use this pattern as baseline and adapt it to the domain:

```text
Resolve the goal end to end.

Before finalizing the strategy, ask:
- Are you 100% confident in this strategy?
- Is it the most ergonomic and optimized way of doing this?
- If not, find all possible loopholes, suggest proper fixes, and run this loop until you are factually 100% confident in the new strategy.

Success means:
- required outcome is complete and verified
- relevant evidence or tool results support the conclusion
- proof is collected with the strongest practical evidence, such as screenshots, logs, full end-to-end tests, or command output
- side effects are limited to approved actions
- final answer includes completed work, validation, blockers, and next action if blocked

Loophole rule:
- if any user requirement could let the agent call the goal complete early without proving success, call it out and revise the prompt with closed feedback conditions and loops that prevent early completion

Work loop:
- inspect available context and choose the smallest useful next action
- act using tools or edits when needed
- verify the result with the strongest practical check and collect proof
- after each result, ask whether the core goal is now complete
- stop when success criteria are met, required user input is missing, or continuing would create unapproved risk
```

## Review Output

Store the draft in the temporary file created by the draft script so feedback can be applied directly to the same artifact. When presenting a draft, include the Plannotator annotation command from the draft script and advise the user they can run it to review and annotate the prompt visually. Use this shape:

`**Draft Goal Prompt**`, `File: /tmp/goal-prompt-<short-slug>.md`, `Review UI: /plannotator annotate /tmp/goal-prompt-<short-slug>.md` `or set the goal manually: /goal @/tmp/goal-prompt-<short-slug>`, then: `Approve to create/update goal from this file, send edits, or run the Review UI command to annotate it.`

## Approval Rule

Never create or update the goal before the user explicitly approves the prompt file. Treat feedback as instructions to revise, not approval.
