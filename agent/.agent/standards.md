# Project Standards

## Code Quality

- Minimum code that solves parity gap.
- No fake-supported flags, routes, docs, or tests.
- Match existing repo patterns and naming.
- No `any`, no unsafe casts, no dynamic imports.
- Use `typebox` when validating boundary payloads.
- Keep workflow-native behavior in bundled resources when local architecture does not need TS ownership.

## Testing

- Reproduce parity gap with focused failing test first when code change is needed.
- Test supported routing, unsupported routing, artifact/state mutations, and resume semantics in slice scope.
- Full repo validation required before slice accepted.

## Architecture

- TS owns command entry, arg parsing, and orchestration boundaries.
- Workflow-launch owns workflow-native command execution.
- Helper runtime may enforce deterministic artifact semantics when agent-only workflow behavior would be too soft.
- Unsupported upstream branches must reject explicitly, not silently degrade.

## Git

- No commit until slice is above 90, review-clean, and full validation passes.
- Keep commits atomic by command slice.
