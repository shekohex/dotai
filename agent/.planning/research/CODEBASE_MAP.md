# Codebase Map

## Summary

Wrote structured repo map to `.planning/research/CODEBASE_MAP.md` and verified contents with line-count plus head/tail spot checks.

## Modules

### Codebase Map

Single-source repo map covering stack, bootstrap, extension architecture, integrations, testing patterns, conventions, and fragile surfaces.

Files: .planning/research/CODEBASE_MAP.md

## Tests

- Verified artifact exists and has 486 lines with `wc -l .planning/research/CODEBASE_MAP.md`.
- Spot-checked beginning and end of `.planning/research/CODEBASE_MAP.md` with `read`.

## Conventions

- TypeScript ESM with `NodeNext` resolution and strict compiler settings.
- `typebox` validates structured inputs, persisted JSON, and external payloads.
- Feature folders expose `index.ts` façades and default-export extension factories.

## Risks

- Runtime monkey-patching of upstream classes in `src/extensions/bundled-resources.ts` and `src/extensions/model-family-system-prompt.ts` is brittle against upstream API changes.
- Several subsystems keep module-local state keyed by cwd or session, so multi-context behavior depends on careful event ordering.
- External integrations depend on tmux, GitHub CLI, Firecrawl-compatible endpoints, LiteLLM, and MCP executor availability.
