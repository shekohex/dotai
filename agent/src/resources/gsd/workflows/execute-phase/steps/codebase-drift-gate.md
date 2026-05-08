# Codebase drift gate

Run after regression/schema gates and before verifier spawn.

Goal:

- surface stale codebase-map risk without blocking supported execute path
- normalize local helper output into orchestrator follow-up contract

Algorithm:

1. Execute `node "$GSD_TOOLS_PATH" verify codebase-drift` from repo root.
2. Parse returned JSON payload.
3. Treat these outcomes as non-blocking drift contract:
   - `skipped=true`
   - `directive=warn`
   - mapper follow-up requested
   - no affected paths detected
4. Record drift result in wave/phase summary.
5. If helper suggests follow-up mapping, keep phase moving but surface exact next action.
6. Never fail verifier spawn or `phase.complete` solely because of codebase drift output.

Required wording:

- `codebase drift gate is non-blocking in supported execute-phase path`
- `follow up with /gsd map-codebase update if drift warning matters to next phase`
