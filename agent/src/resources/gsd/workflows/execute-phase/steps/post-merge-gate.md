# Post-merge gate

Run after orchestrator merges full wave result back into main checkout and before verifier spawn.

Goal:

- enforce build/test regression gate on merged tree
- guard progress tracking when merged tree is red
- keep failed merges from incorrectly advancing phase completion

Algorithm:

1. Confirm merge/cleanup bookkeeping finished for current completed plan batch.
2. Inspect full-wave merged tree for unresolved conflicts or dirty state that would invalidate verification.
3. Run project-standard build/test gate on full-wave merged tree.
4. If build/test gate fails:
   - block verifier spawn
   - block `phase.complete`
   - tracking guard on failed tests: do not mark roadmap row complete and do not advance phase-complete state
   - do not run `roadmap update-plan-progress` for that failed merged wave
   - preserve failing command output in orchestrator summary
5. If build/test gate passes:
   - permit regression gate success
   - allow roadmap progress refresh for completed plans in that full merged wave and later verifier spawn

Required wording:

- `build/test gate failed after merge; tracking guard remains active`
- `post-merge gate passed; merged tree ready for verifier`
