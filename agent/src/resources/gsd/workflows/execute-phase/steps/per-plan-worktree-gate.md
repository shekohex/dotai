# Per-plan worktree gate

Run before dispatching any plan in `/gsd execute-phase`.

Goal:

- decide worktree isolation per plan, not per phase
- prevent submodule/path collisions and same-wave write overlap
- produce deterministic allow/downgrade/disable outcome for orchestrator lane assignment

Inputs:

- project-level worktree setting from init/config
- indexed plan metadata for current wave
- current plan `files_modified`
- sibling plans in same wave after command filters
- submodule paths from `.gitmodules` when present

Algorithm:

1. Start with `worktreeAllowed = workflow.use_worktrees` or equivalent init/config default.
2. If project-level worktree mode is off, return disable immediately.
3. Normalize current plan `files_modified`:
   - trim whitespace
   - drop empty paths
   - compare repo-relative paths only
4. If repo has submodules and current plan has no parseable `files_modified`, disable for safety.
5. Parse `.gitmodules` submodule paths, normalize to repo-relative prefixes.
6. For each current plan path, test intersection against each submodule path:
   - exact match blocks
   - plan path nested inside submodule blocks
   - submodule path nested inside declared plan path blocks
7. If any submodule intersection exists, disable worktree for current plan only.
8. Compute same-wave sibling intersections using actual set overlap algorithm:
   - convert current plan paths to set `currentPaths`
   - convert each sibling plan paths to set `siblingPaths`
   - direct overlap if `currentPaths ∩ siblingPaths != ∅`
   - parent-child overlap if any path in one set is prefix directory of path in other set
   - ignore sibling plan if it is already complete or filtered out of this run
9. If same-wave overlap exists:
   - do not globally disable worktrees
   - mark plan for sequential lane or isolated merge order
   - this is intra-wave overlap downgrade, not outright plan rejection
10. If no blocking condition exists, allow worktree isolation.

Decision outputs:

- `allow`: worktree isolation enabled for plan and may run in parallel lane
- `downgrade`: worktree isolation allowed but plan must run in sequential lane because of same-wave overlap
- `disable`: worktree isolation disabled for current plan because of project setting, unknown paths with submodules, or submodule/path intersection

Required handoff wording when disabled:

- `worktree isolation disabled for plan due to submodule/path safety gate`

Required handoff wording when enabled:

- `worktree isolation allowed for plan after per-plan gate`

Required handoff wording when downgraded:

- `intra-wave overlap downgrade applied; plan stays sequential in this wave`
