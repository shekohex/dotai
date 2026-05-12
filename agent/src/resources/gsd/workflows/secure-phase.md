# secure-phase workflow

Purpose:

- provide real grouped local `/gsd secure-phase` route for verify-work completion gating
- keep lifecycle entry TS-thin and workflow-launch based
- preserve enforceable security review semantics in bundled local runtime

Required local reading before execution:

- `$GSD_BUNDLE_DIR/commands/gsd/secure-phase.md`
- `$GSD_BUNDLE_DIR/agents/gsd-security-auditor.md`

Core rules:

1. Treat this file as local adapted behavior contract, not literal shell script.
2. Review current phase threat model, security config, SECURITY.md, and open threats.
3. If threats remain unresolved, stop with explicit remediation summary.
4. If clear, report security clear for phase completion routing.
5. Use grouped local command names in user-facing guidance.

Execution shape:

1. Initialize phase context.

```bash
INIT=$(gsd-sdk query init.phase-op "${PHASE_ARG}")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
AGENT_SKILLS_AUDITOR=$(gsd-sdk query agent-skills gsd-security-auditor)
AUDITOR_MODEL=$(gsd-sdk query resolve-model gsd-security-auditor --raw)
SECURITY_CFG=$(gsd-sdk query config-get workflow.security_enforcement --raw 2>/dev/null || echo "true")
```

2. If `SECURITY_CFG` is `false`, stop with `Security enforcement disabled. Enable via /gsd settings.`
3. Detect input state from current phase artifacts.

```bash
SECURITY_FILE=$(ls "${PHASE_DIR}"/*-SECURITY.md 2>/dev/null | head -1)
PLAN_FILES=$(ls "${PHASE_DIR}"/*-PLAN.md 2>/dev/null)
SUMMARY_FILES=$(ls "${PHASE_DIR}"/*-SUMMARY.md 2>/dev/null)
```

4. If no `SUMMARY_FILES` exist, stop with `Phase {N} not executed. Run /gsd execute-phase {N} first.`
5. Build Threat Register from PLAN threat model and SUMMARY threat flags.
6. Track `register_authored_at_plan_time`.
7. If `threats_open: 0` and `register_authored_at_plan_time: false`, do not rubber-stamp success. Run retroactive-STRIDE mode first.
8. Present threat table and options:
   - verify all open threats
   - accept all open and document accepted risks
   - cancel
9. Spawn `gsd-security-auditor` with complete phase context when verification is required.
10. Write/Update SECURITY.md with threat register status, accepted risks, and audit trail.
11. If `threats_open > 0`, block advancement and do not emit next-step routing.
12. If `threats_open: 0`, commit and show grouped next commands.

Required branch behavior:

- Build Threat Register from PLAN/SUMMARY artifacts before making claims.
- Support retroactive-STRIDE mode when no authored threat model exists.
- Record accepted risks in `*-SECURITY.md` when user chooses acceptance.
- Write/Update SECURITY.md for both create and update paths.
- `threats_open > 0 BLOCKS advancement`.
- On success, commit with:

```bash
gsd-sdk query commit "docs(phase-${PHASE}): add/update security threat verification"
```

- On success, route with grouped command names only: `/gsd validate-phase {N}` and `/gsd verify-work {N}`.
