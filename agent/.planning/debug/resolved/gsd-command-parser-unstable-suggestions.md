---
slug: gsd-command-parser-unstable-suggestions
status: resolved
trigger: "/gsd command parser suggests commands that should not match; expected upstream pi fuzzy search behavior"
goal: find_and_fix
created: 2026-05-06
updated: 2026-05-06T00:45:00Z
---

## Symptoms

- Expected: Parser should use upstream pi fuzzy search behavior for /gsd command suggestions.
- Actual: Suggestions appear unstable and include commands that should not fit; matching does not feel like fuzzy search.
- Repro: `/gsd debug`
- Errors: none
- Timing/regression: not provided
- User-selected target: Investigate command matching/suggestion algorithm first

## Current Focus

- reasoning_checkpoint_hypothesis: "`src/extensions/gsd/state/debug.ts` rejects valid debug session files because `DebugSessionFrontmatterSchema` only allows `status`, `trigger`, `created`, and `updated`, while real session files include `slug` and `goal`; `/gsd` autocomplete calls `listDebugSessions()`, which throws while parsing those files."
- reasoning_checkpoint_confirming_evidence_1: "Current session frontmatter includes `slug` and `goal`, and stack trace shows failure inside `readDebugSession()` -> `parseMarkdownFrontmatter()` with `must not have additional properties`."
- reasoning_checkpoint_confirming_evidence_2: "`DebugSessionFrontmatterSchema` sets `additionalProperties: false` and does not declare `slug` or `goal`."
- reasoning_checkpoint_falsification_test: "If a regression test parsing a debug file with `slug` and `goal` already passes under current schema, this hypothesis is wrong."
- reasoning_checkpoint_fix_rationale: "Allowing optional `slug` and `goal` in debug session frontmatter matches actual session file format and prevents `/gsd` autocomplete from crashing while listing sessions."
- reasoning_checkpoint_blind_spots: "Have not yet checked whether other debug metadata keys beyond `slug` and `goal` can appear in real session files."
- hypothesis: Allowing optional `slug` and `goal` fixes `/gsd` autocomplete crashes on real debug session files.
- test: User verifies `/gsd` autocomplete works again in interactive session with existing debug files.
- expecting: `/gsd` no longer throws frontmatter validation errors and debug session suggestions render normally.
- next_action: Ask user to verify `/gsd` autocomplete in real session and report result.

## Evidence

- timestamp: 2026-05-06
  source: intake
  note: User reports unstable `/gsd` suggestions and explicitly expects upstream pi fuzzy search behavior.
- timestamp: 2026-05-06T00:05:00Z
  source: src/extensions/gsd/autocomplete.ts
  note: `filterItems()` uses `label + value + description` as fuzzy search text for GSD suggestions.
- timestamp: 2026-05-06T00:06:00Z
  source: /home/coder/.cache/checkouts/github.com/badlogic/pi-mono/packages/tui/src/autocomplete.ts
  note: Upstream slash-command autocomplete filters commands by command name only.
- timestamp: 2026-05-06T00:08:00Z
  source: runtime comparison
  note: Query `de` returns `[debug, off]` with local text shape and `[debug]` with upstream name-only text shape; query `pl` similarly returns multiple false positives locally but only `complete-milestone` upstream.
- timestamp: 2026-05-06T00:31:00Z
  source: user runtime error
  note: `/gsd` autocomplete crashes in `readDebugSession()` because frontmatter validation rejects additional properties.
- timestamp: 2026-05-06T00:33:00Z
  source: src/extensions/gsd/state/debug.ts
  note: `DebugSessionFrontmatterSchema` only permits `status`, `trigger`, `created`, and `updated` with `additionalProperties: false`.

## Resolution

- root_cause: `DebugSessionFrontmatterSchema` is stricter than actual debug session file frontmatter and crashes `/gsd` autocomplete when session files include `slug` and `goal`.
- fix: Added optional `slug` and `goal` fields to `DebugSessionFrontmatterSchema` so `/gsd` debug session parsing accepts actual session frontmatter.
- verification: Targeted regression passed; `test/gsd/commands.test.ts` passed; `npm run typecheck` passed; `npm run lint` passed; `npm run format:check` passed.
