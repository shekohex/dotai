<purpose>
Run efficient project initialization from prepared `.planning/` files: questioning, preference collection, optional research, requirements, roadmap, then phase-1 handoff.
</purpose>

<required_reading>
Read invoking command file and all bundled references/templates before acting.
</required_reading>

<local_contract>

- Prepared bootstrap files may already contain placeholders. Replace placeholder content with final project content.
- Work in current visible session.
- This is local adapted workflow, not full upstream shell/runtime parity.
- Command handler preflight already ran before this workflow started. Do not run `git init` or recreate bootstrap files unless steering prompt explicitly says preflight failed.
- If steering metadata says `GIT_WORKTREE_READY=true`, git setup is already satisfied even when repo root lives in parent directory. Do not create nested `.git/` in current directory.
- If steering metadata says `HAS_ACCIDENTAL_NESTED_GIT_REPO=true`, do not continue assuming current directory is clean standalone git root. Call out nested-git state clearly and ask user whether to keep isolated repo or use enclosing parent repo.
- Use delegated subagents only for project research and roadmap creation.
- Preserve local grouped UX and local `.planning` layout.
- Use `ask_user_question` when structured multi-question selection helps. Use plain conversation when user needs freeform explanation.
  </local_contract>

<runtime_contract>

- Steering prompt injects concrete runtime paths and targets. Use those exact values when spawning subagents or generating files.
- Steering prompt also injects init metadata. Branch on those values instead of re-inferring from vague cues.
- Expect these keys in steering prompt extra instructions:
  - `PROJECT_NAME`
  - `IS_BROWNFIELD`
  - `HAS_CODEBASE_MAP`
  - `NEEDS_CODEBASE_MAP`
  - `CODEBASE_DOCS`
  - `GIT_WORKTREE_READY`
  - `GIT_ROOT_PATH`
  - `ENCLOSING_GIT_ROOT_PATH`
  - `HAS_ACCIDENTAL_NESTED_GIT_REPO`
  - `GSD_BUNDLE_DIR`
  - `GSD_TOOLS_PATH`
  - `INSTRUCTION_FILE_NAME`
  - `INSTRUCTION_FILE_PATH`
  - `AVAILABLE_AGENT_TYPES`
- If a named delegated agent is unavailable at runtime, fall back to doing equivalent work in main session and write same target files directly.

</runtime_contract>

<available_agent_types>

- gsd-project-researcher
- gsd-research-synthesizer
- gsd-roadmapper
  </available_agent_types>

<process>

## 1. Preflight

- If `.planning/ROADMAP.md` already has real phases and `.planning/PROJECT.md` is already project-specific, stop and tell user to use `/gsd progress`.
- If files exist but still look like bootstrap placeholders or unfinished initialization, continue and recover in place.
- Git should already be initialized by command preflight. If not, initialize it before continuing so commit-based steps stay valid.
- Brownfield branch:
  - If `IS_BROWNFIELD=true` and `NEEDS_CODEBASE_MAP=true`, explicitly say this looks like an existing repo and offer `/gsd map-codebase` before generic intake.
  - If user declines mapping, continue with brownfield-aware questioning.
  - If `IS_BROWNFIELD=true` and `HAS_CODEBASE_MAP=true`, skip greenfield framing and continue with repo-aware questioning.
  - If `CODEBASE_DOCS` is non-empty, read those `.planning/codebase/*.md` docs and use them as primary brownfield context.

## 2. Questioning

- If `--auto`, skip freeform questioning. Extract project intent from provided idea text or file input and continue.
- If `IS_BROWNFIELD=true`, do not ask generic greenfield intake like `What do you want to build?`.
- In brownfield interactive mode, start with repo-aware framing such as: `What do you want to build or change next in ${PROJECT_NAME}?`
- In interactive mode, start with: `What do you want to build?`
- Follow thread. Use `references/questioning.md` style.
- Stop only when enough context exists to write PROJECT.md, REQUIREMENTS.md, and roadmap direction.
- Use short stage banner styling from `references/ui-brand.md`.

## 3. Config Shape

- Ask init preferences before finalizing config.
- Keep local config compatible with existing readers.
- Capture at least: `model_profile`, `granularity`, `commit_docs`, `parallelization`, `workflow.research`, `workflow.plan_check`, `workflow.verifier`, `workflow.nyquist_validation`.
- If `--auto` present, assume research/plan-check/verifier enabled unless user-provided document strongly implies lighter setup.
- Rewrite `.planning/config.json` after preferences are chosen.
- If `commit_docs: false`, add `.planning/` to `.gitignore` deterministically before finishing init.

## 4. PROJECT.md

- Write full project context into `.planning/PROJECT.md` using bundled `templates/project.md` as shape guidance.
- If brownfield codebase docs exist, ground project context in `.planning/codebase/STACK.md`, `ARCHITECTURE.md`, `STRUCTURE.md`, `CONVENTIONS.md`, `TESTING.md`, `CONCERNS.md`, and `INTEGRATIONS.md` where present.
- For greenfield, keep Active requirements as hypotheses.
- Record core value, constraints, context, out-of-scope boundaries, and initial key decisions.

## 5. Research

- Decide with user unless `--auto`.
- If researching, create `.planning/research/STACK.md`, `FEATURES.md`, `ARCHITECTURE.md`, `PITFALLS.md`, then synthesize `.planning/research/SUMMARY.md`.
- Delegation preflight:
  - Only delegate if `AVAILABLE_AGENT_TYPES` includes needed agent name.
  - Otherwise do same work in main session.
- Researcher task contract:
  - Agent: `gsd-project-researcher`
  - Prompt file: steering prompt provides concrete `researcher prompt=` path.
  - Required reading block for each researcher task must include concrete project files and template path it is writing against.
  - Output map:
    - `STACK.md` uses concrete `template STACK=` path and writes `.planning/research/STACK.md`
    - `FEATURES.md` uses concrete `template FEATURES=` path and writes `.planning/research/FEATURES.md`
    - `ARCHITECTURE.md` uses concrete `template ARCHITECTURE=` path and writes `.planning/research/ARCHITECTURE.md`
    - `PITFALLS.md` uses concrete `template PITFALLS=` path and writes `.planning/research/PITFALLS.md`
  - Prompt shape for each delegated researcher task:

    ```text
    <required_reading>
    [absolute path to .planning/PROJECT.md]
    [absolute path to .planning/REQUIREMENTS.md if present]
    [absolute path to target template path]
    [absolute path to researcher prompt file]
    </required_reading>

    Write exactly one research artifact: [target output path].
    Use template shape from [target template path].
    Return short completion summary only.
    ```

- Synthesizer task contract:
  - Agent: `gsd-research-synthesizer`
  - Prompt file: steering prompt provides concrete `synthesizer prompt=` path.
  - Required reading must include all four concrete research output paths, concrete `template SUMMARY=` path, and synthesizer prompt path.
  - Writes `.planning/research/SUMMARY.md`.
- Keep file ownership deterministic: one task per output file.

## 6. REQUIREMENTS.md

- Convert context and any research into explicit v1 requirements, deferred v2 items, and out-of-scope exclusions.
- If brownfield codebase docs exist, infer current system capabilities/constraints from them and avoid blank-slate requirements framing.
- Use user-centric, testable, atomic requirement wording.
- Add traceability table scaffold.
- If `--auto`, skip interactive requirements approval and proceed from extracted document scope.

## 7. ROADMAP.md and STATE.md

- Use roadmapper when possible.
- If brownfield codebase docs exist, use them to shape phase boundaries, dependency ordering, and risk hotspots.
- Roadmapper delegation contract:
  - Agent: `gsd-roadmapper`
  - Prompt file: steering prompt provides concrete `roadmapper prompt=` path.
  - Required reading must include absolute paths for `.planning/PROJECT.md`, `.planning/REQUIREMENTS.md`, optional `.planning/research/SUMMARY.md`, concrete `template ROADMAP=` path, and roadmapper prompt path.
  - Writes `.planning/ROADMAP.md`, updates `.planning/STATE.md`, updates traceability in `.planning/REQUIREMENTS.md`.
  - If agent unavailable, main session performs same writes directly.
- Create real phases in `.planning/ROADMAP.md` using bundled roadmap template.
- Map every v1 requirement to exactly one phase.
- Update `.planning/STATE.md` so local readers see current phase 1, current phase name, empty current plan, and status `Ready to discuss phase`.

## 8. Roadmap Approval

- If `--auto`, skip this approval loop and treat roadmap as auto-approved.
- Present roadmap summary.
- Ask for explicit approval before finishing initialization.
- If user wants changes, revise roadmap and loop until approved.
- Do not mark initialization complete while roadmap is still under review.

## 9. Finish

- Refresh the runtime instruction file before completion: `AGENTS.md` for Codex, `CLAUDE.md` otherwise.
- Generate that file deterministically using runtime contract values from steering prompt:
  `node "$GSD_TOOLS_PATH" generate-claude-md --output "$INSTRUCTION_FILE_PATH"`
- Summarize artifacts created.
- Tell user next step: `/gsd discuss-phase 1`.
- If `--auto`, chain directly to next step without waiting for manual approval.
- If workflow could not complete because user stopped before approvals, leave current artifacts coherent and say what remains.

</process>
