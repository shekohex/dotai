---
name: creating-goals
description: Draft or revise a durable agent goal and install an approved prompt. Use for explicit goal-authoring or goal-tool requests.
---

# Creating Goals

Use this skill to write goal prompts that another agent can execute autonomously with a closed feedback loop.

## Prompt guidance

Use the outcome and completion rules below. Read `references/PROMPT_GUIDE_GPT5_5.md` only when targeting GPT-5.5 or needing its specific formatting, citation, or Responses phase guidance; it is not a prerequisite for every goal draft.

## Workflow

1. Read relevant codebase files, docs, and prior context that can answer open questions about the goal.
2. Ask the user for clarification before drafting when the goal is still ambiguous after inspection.
3. Run `./scripts/draft-goal.sh <short-slug>` on Unix or `./scripts/draft-goal.ps1 <short-slug>` on PowerShell to create the temporary draft file and print its path.
4. The file has YAML frontmatter plus a prompt template. Fill in frontmatter deterministically, remove optional sections that add no task-specific guidance, then write the goal prompt from the user's intent and discovered context. Present that file path for review before using any goal tool.
5. If the user requests changes, update the temporary file and present the same file path again. Repeat until explicit approval.
6. If the user approves, call the `goal` tool to create or update the goal using `objectiveFile` with the absolute path to the approved prompt file. Prefer `objectiveFile` over inline `objective` so the file content is used exactly as written and the prompt is not duplicated into the tool call. If the `goal` tool is unavailable, ask the user to run `/goal on`.
7. After goal tool success, delete the temporary file, then report the goal created or updated and any identifier returned by the tool.

## Draft Script

Use the script from the skill directory:

Unix: `./scripts/draft-goal.sh <short-slug>`

PowerShell: `./scripts/draft-goal.ps1 <short-slug>`

The script creates `/tmp/goal-prompt-<short-slug>.md` or the platform temp equivalent. It prints the draft file path. It does not overwrite an existing draft.

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
- checks for unresolved requirement gaps that would prevent verified completion
- final output shape

Do not add token limits, turn limits, time estimates, or artificial iteration caps unless the user explicitly asks.

## Closed Feedback Loop Pattern

Use this pattern as baseline and adapt it to the domain:

```text
Resolve the goal end to end.

Choose a strategy that covers the stated requirements. Resolve material gaps with evidence; do not keep optimizing once success criteria are satisfied.

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
- verify with checks that establish the required outcome and collect relevant proof
- fix in-scope failures and rerun affected checks; reuse unchanged valid results
- after each result, ask whether the core goal is now complete
- stop when success criteria are met, required user input is missing, or continuing would create unapproved risk
```

## Review Output

Store the draft in the temporary file created by the draft script so feedback can be applied directly to the same artifact. Present its path for review and ask the user to approve or request edits. Use this shape:

`**Draft Goal Prompt**`, `File: /tmp/goal-prompt-<short-slug>.md`, `or set the goal manually: /goal @/tmp/goal-prompt-<short-slug>`, then: `Approve to create/update goal from this file or send edits.`

## Approval Rule

Never create or update the goal before the user explicitly approves the prompt file. Treat feedback as instructions to revise, not approval.
