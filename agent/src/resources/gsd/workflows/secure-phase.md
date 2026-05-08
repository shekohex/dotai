# secure-phase workflow

Purpose:

- provide real grouped local `/gsd secure-phase` route for verify-work completion gating
- keep lifecycle entry TS-thin and workflow-launch based

Required local reading before execution:

- `$GSD_BUNDLE_DIR/commands/gsd/secure-phase.md`
- `$GSD_BUNDLE_DIR/agents/gsd-security-auditor.md`

Core rules:

1. Treat this file as local adapted behavior contract, not literal shell script.
2. Review current phase threat model, security config, SECURITY.md, and open threats.
3. If threats remain unresolved, stop with explicit remediation summary.
4. If clear, report security clear for phase completion routing.
5. Use grouped local command names in user-facing guidance.
