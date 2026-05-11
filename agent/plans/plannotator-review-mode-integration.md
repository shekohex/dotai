## Context

- Goal: make Plannotator AI review use our review pipeline concepts without routing through `/review` command itself.
- User requirement: reuse review mode behavior, review prompt construction, and review model selection so browser-launched AI review in Plannotator matches main review experience.
- Additional user requirement: `submit_plan` tool UI should look and behave like our first-party browser tools, especially `src/extensions/interview`, rather than like vendored/upstream Plannotator UX.
- Current Plannotator review UI launches provider-specific agent jobs from `src/extensions/plannotator/server/review-agent-jobs.ts`.
- Current prompts there come from Plannotator-generated modules like `generated/agent-review-message.ts`, `generated/codex-review.ts`, and `generated/claude-review.ts`.
- Main review pipeline currently builds target-aware prompts and shared review task framing in:
  - `src/extensions/review/prompts.ts`
  - `src/extensions/review/prompting.ts`
  - `src/extensions/review/run-execution.ts`
  - `src/extensions/review/guidelines.ts`
- Main review extension also owns shared review custom instructions/runtime state under `src/extensions/review/runtime-state.ts` and `src/extensions/review/state.ts`.
- `interview` shows preferred browser-tool architecture in this repo:
  - typed tool schema + `renderShell: "self"` registration in `src/extensions/interview/index.ts`
  - browser/server orchestration in `src/extensions/interview/execute.ts`
  - explicit queued/ready/progress/completed details and clickable URLs
  - server contract/runtime split in `src/extensions/interview/server*.ts`
- Plannotator must still keep its own browser/server shell and annotation mapping.

## Approach

- Extract a small shared review-input layer from `src/extensions/review` instead of trying to invoke `/review` command or subagent runtime directly.
- Shared layer should produce review-ready prompt inputs for any caller:
  - target label
  - review instructions for target/diff
  - task prompt wrapper
  - project review guidelines
  - shared custom instructions
- Plannotator AI review should run through the same review-mode execution path under the hood:
  - use our review subagent SDK / review runtime launch path
  - use structured subagent output with JSON Schema for review findings/result payloads
  - use the same review-mode-selected model defaults
  - use the same review-mode agent loop/tool environment users already get in review mode
  - adapt structured review results into Plannotator browser annotations after subagent completion
- That means the agent loop should have the same tool-style capabilities review mode has today, such as normal code-reading and shell exploration behavior, rather than a separate Plannotator-only limited command runner.
- Mode alignment should come from the canonical `review` mode, not from current active mode and not from separate Plannotator-only model selection.
- Fold `submit_plan` tool UX into our native browser-tool pattern used by `interview`:
  - explicit self-rendered shell
  - structured details payload for queued/ready/in-progress/result states
  - shared browser open/manual-open behavior and clickable links
  - server contract/runtime separation that matches repo conventions
- Limit `submit_plan` UX scope to self-render + minimal tool call/result noise in TUI. Do not redesign Plannotator browser pages beyond what is needed for native-feeling tool shell behavior.
- Keep changes surgical: browser UI, review server routes, and annotation rendering stay Plannotator-specific.

## Files to Modify

- `src/extensions/review/`
  - add shared helper module for prompt/model resolution, likely near `prompting.ts` / `prompts.ts`
  - likely extend shared review executor/runtime seams so non-`/review` callers can launch review-mode runs
  - export helper(s) from `deps.ts` only if needed
- `src/extensions/plannotator/plannotator-command-handlers.ts`
  - align `submit_plan` registration/rendering/update payloads with first-party tool UX conventions
- `src/extensions/plannotator/plannotator-browser.ts`
  - align browser-session launch/status handling with `interview` browser-tool behavior
- `src/extensions/plannotator/server/review-agent-jobs.ts`
  - replace Plannotator-specific review launch path with review-mode-backed subagent adapter
  - remove bespoke provider-specific launch logic there
  - keep only Plannotator-specific annotation/result mapping there
- `src/extensions/plannotator/server/review-local-deps.ts`
  - re-export shared review helper(s) if dependency fanout needs containment
- `src/extensions/plannotator/server/review-ai.ts`
  - remove if review-mode-backed execution fully replaces separate Plannotator provider registry
- `src/extensions/plannotator/server/serverReview.ts`
  - thread runtime inputs needed for shared review prompt/model resolution
- `src/extensions/plannotator/server/serverPlan.ts` and related plan-review helpers
  - normalize `submit_plan` server/runtime contract around our browser-tool patterns if current vendored shape diverges
- Tests
  - existing review/plannotator harness coverage plus new focused tests for prompt/model reuse

## Reuse

- Reuse `buildReviewPrompt(...)` from `src/extensions/review/prompts.ts` for target-aware review instructions where target mapping is possible.
- Reuse `buildReviewTaskPrompt(...)` from `src/extensions/review/prompting.ts` for shared review framing.
- Reuse `loadProjectReviewGuidelines(...)` from `src/extensions/review/guidelines.ts`.
- Reuse review custom-instructions state loader from `src/extensions/review/state.ts` or factor a narrower read helper from review runtime/state modules.
- Reuse review subagent/runtime path from:
  - `src/extensions/review/execution-bridge.ts`
  - `src/extensions/review/runtime-lifecycle.ts`
  - `src/extensions/review/run-execution.ts`
- Reuse subagent structured-output pattern already used elsewhere in repo for JSON Schema validated completions.
- Reuse mode registry/mode spec lookup from existing mode utilities instead of adding new Plannotator config.
- Reuse `interview` browser-tool patterns for:
  - tool registration surface
  - browser open/manual-open messaging
  - details/result shaping
  - server contract/runtime split
- Reuse current Plannotator provider launch/parsing code only for transport/output normalization.

## Steps

1. Define shared boundary.
   - Add one shared helper that returns review prompt inputs independent of `/review` command runtime.
   - Verify: helper can be called from both review extension code and Plannotator server code without importing browser/server-only modules.

2. Model review target mapping for Plannotator.
   - Map Plannotator diff context and PR metadata into review target semantics compatible with `review/prompts.ts`.
   - For unsupported cases, define explicit fallback path using current Plannotator diff instruction builder.
   - Verify: each Plannotator review mode (`branch`, PR, worktree/local diff variants) produces deterministic prompt inputs.

3. Resolve review-mode model selection.
   - Read canonical `review` mode config from existing mode registry/settings.
   - Use that resolved model/thinking defaults for all Plannotator AI review launches.
   - Verify: when `review` mode model changes, Plannotator AI review picks same default model family/config.

4. Switch Plannotator AI review launch to review-mode runtime.
   - Refactor Plannotator AI review so browser-triggered review launches through shared review executor/subagent SDK path instead of a separate bespoke provider command path.
   - Use structured output JSON Schema for completion payloads so findings can be consumed deterministically by Plannotator.
   - Ensure launched agent gets same review-mode loop semantics and tools as normal review mode.
   - Verify: spawned review run uses same review-mode backend assumptions as `/review`, even though trigger remains Plannotator UI.

5. Reuse shared review prompt framing.
   - Make Plannotator AI review prompt assembly come from shared review helper output used by review mode.
   - Remove duplicated Plannotator-only prompt assembly and provider-specific wrappers that are no longer needed once built-in review loop is used.
   - Verify: generated prompt contains review target, shared review instructions, optional custom instructions, and project guidelines.

6. Align `submit_plan` tool UX with `interview`.
   - Audit `src/extensions/interview/index.ts`, `execute.ts`, and `server*.ts` for our standard browser-tool UX shape.
   - Refactor `submit_plan` flow to expose equivalent ready/progress/result states and self-rendered shell behavior where missing.
   - Normalize manual-open/clickable-link handling and status updates to match first-party tool behavior.
   - Verify: `submit_plan` feels like our browser tools, not an upstream vendored special case.

7. Reuse shared review custom instructions.
   - Read persisted review custom instructions from same source as review extension.
   - Feed them into shared prompt builder for Plannotator AI review.
   - Verify: custom review instructions set in review flow appear in Plannotator AI review prompt.

8. Add focused tests.
   - Unit-test shared helper outputs for review mode + Plannotator call sites.
   - Add integration coverage that Plannotator AI review launches through review-mode-backed executor/runtime path and exposes expected tool/model assumptions.
   - Add coverage for structured subagent JSON output to annotation mapping.
   - Add focused tests for `submit_plan` tool details/render/update states modeled after interview tool behavior.
   - Add integration test that Plannotator AI review prompt uses review-mode prompt framing and review-mode-selected model defaults.
   - Verify: tests fail before change and pass after change.

9. End-to-end validation.
   - Run full repo checks.
   - Manually sanity-check `/plannotator-review` browser session still launches and AI review findings still annotate UI.
   - Manually sanity-check `submit_plan` browser flow now presents native-feeling ready/progress/result UX.

## Verification

- Focused tests:
  - shared review prompt builder tests
  - Plannotator review-agent job prompt/model tests
  - `submit_plan` UX/details/render tests
- Existing suite:
  - `npm run typecheck`
  - `npm test`
  - `npm run lint`
  - `npm run format:check`
- Manual behavior checks:
  - `submit_plan` shows native browser-tool style updates and clickable open URL
  - `/plannotator-review` opens review UI
  - browser-launched AI review still returns annotations
  - browser-launched AI review uses same review-mode backend behavior/tools as normal review mode
  - prompt includes shared review framing/guidelines/custom instructions
  - resolved model aligns with review mode defaults
