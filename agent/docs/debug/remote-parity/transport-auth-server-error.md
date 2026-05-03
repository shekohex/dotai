---
status: investigating
trigger: "Start remote client against invalid origin http://127.0.0.1:9"
created: 2026-05-03T18:31:00Z
updated: 2026-05-03T18:31:00Z
---

## Current Focus

hypothesis: remote startup transport failure currently escapes as raw fetch exception instead of user-facing recovery surface
test: launch remote client against unreachable origin and inspect visible output
expecting: remote mode should surface actionable connection/auth error
next_action: later compare against any feasible local analogue or mark remote-only failure path explicitly

## Symptoms

expected: remote startup failure should produce clear error surface with recovery affordance
actual: startup exits with uncaught `TypeError: fetch failed` stack trace from auth request path
errors: `TypeError: fetch failed`
reproduction: run `npm run pi:remote -- --remote-url http://127.0.0.1:9 --identity alice --workspace-cwd ...`
started: audit run 2026-05-03

## Eliminated

- hypothesis: failure came from session bootstrap after successful auth
  evidence: stack trace stops in `requestRemoteAuthToken` / `authenticateWithChallenge`
  timestamp: 2026-05-03T18:31:00Z

## Evidence

- timestamp: 2026-05-03T18:31:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch11/transport-auth-server-error/remote.out
  found: process prints uncaught `TypeError: fetch failed` with stack through `src/remote/runtime-api/auth.ts` and `src/remote/client-interactive.ts`
  implication: remote-only transport failure surface is raw and likely user-hostile

- timestamp: 2026-05-03T18:31:00Z
  checked: .pi/remote-e2e/audit-2026-05-03-batch11/transport-auth-server-error/status.txt
  found: nonzero process exit after startup failure
  implication: failure is reproducible and not a transient visible warning

## Resolution

root_cause:
fix:
verification:
files_changed: []
