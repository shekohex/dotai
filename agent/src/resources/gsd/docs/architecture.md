# GSD Architecture

## Extension Shell

- built-in extension under `src/extensions/gsd`
- toggled per workspace
- grouped `/gsd` command surface
- session-start brownfield adoption

## Persistent State

- `.planning` is durable compatibility boundary
- TypeBox schemas validate settings and persisted payloads
- runtime reads state, roadmap, plans, summaries, validation artifacts

## Worker System

- bundled `gsd-*` modes injected into `.pi/modes.json`
- worker roles map to modes
- prompts bundled in repo
- subagents launched through internal SDK wrappers

## Orchestration

- `plan-phase` -> planner -> plan-checker -> state/report writes
- `execute-phase` -> executor -> verifier -> state/report writes
- `verify-work` -> verifier -> state/report writes
- `map-codebase` and `discuss-phase` use structured worker outputs

## UI

- `/gsd` dashboard uses pi-tui custom components
- `/gsd help` exposes command surface and doc inventory
- bundled docs ship with extension resources
