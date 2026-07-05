# Testing

Tests run on Vitest. The suite mixes unit tests, a TUI/tool-rendering "harness", and scenario/integration tests.

## Configuration

`vitest.config.ts`:

- `test.dir = "test"`, `include = ["**/*.test.ts"]`.
- `setupFiles = ["./test/test-utils/setup-env.ts"]`.
- `pool = "forks"`, `maxWorkers` 6 locally / 8 in GitHub Actions, `testTimeout` 30s in CI.
- Reporters: `minimal` (no summary) + `json` → `/tmp/vitest-results.json`.
- Coverage: `v8` provider, includes `src/**/*.ts`, excludes `test/**`, output `.tmp/coverage/`.
- Alias: `@support/pi-test-harness` → `test/support/pi-test-harness`.

## npm test scripts

| Script | Runs |
| --- | --- |
| `npm test` | `vitest run` (whole suite). |
| `npm run test:json` | `vitest run --reporter=json` and prints the results path (for tooling). |
| `npm run test:coverage` | `vitest run --coverage`. |
| `npm run test:tool-preview` | `vitest run ./test/tool-preview.test.ts` — the tool-preview harness. |
| `npm run test:harness` | `vitest run` over `harness`, `review`, `coreui-editor`, `coreui-builtins`. |
| `npm run test:subagent` | `commit`, `subagent`, `subagent-sdk`. |
| `npm run test:executor` | `./test/executor.test.ts`. |
| `npm run test:keys` | `./test/pi-tui-keys.test.ts`. |

## Test categories

The `test/` directory mirrors the extension surface:

- `test/dynamic-workflows/` — workflow parser, runtime, agent, UI, manager, commands, saved-commands, simplify, builtin-workflows, worktree, task-panel, etc.
- `test/gsd/` — lifecycle, state/schema, orchestration, modes, drift, health, planning, UAT, verify-work, roadmap, brownfield, legacy-planning, golden-planning.
- `test/coreui/` — background-bash (ui/messages/herdr-backend/backend), github-pull-request, plus top-level `coreui-*.test.ts` (editor, builtins, skill/github-reference-autocomplete, agent-end-summary).
- `test/support/pi-test-harness/` — the shared harness: `mock-pi`, `mock-ui`, `mock-tools`, `sandbox`, `session`, `events`, `diagnostics`, `playbook`, `utils`, `types`.
- Top-level: `executor`, `harness`, `review`, `tool-preview`, `commit`, `subagent`, `subagent-sdk`, `subagent-launch`, `subagent-sdk-spawn.scenarios`, `pi-tui-keys`, `pi-osc-extension`, `bundled-skills`, `inline-extension-names`, `notify-*`, `terminal-notify`, `session-name`, `review-helpers.scenarios`, plus `update/` (version, command, package-manager).

`*.scenarios.ts` files are shared scenario fixtures (not run directly). The harness alias `@support/pi-test-harness` is how tests import the mock infrastructure.

## Custom oxlint rules

`support/oxlint-plugin-project-rules/` (`index.mjs` + `rules/*.mjs` + `utils/`) implements the lint discipline referenced in the root `AGENTS.md` ("import, TypeScript, TypeBox, Reflect, JSON.parse, unsafe-boundary, and complexity rules"):

| Rule | Enforces |
| --- | --- |
| `no-unsafe-json-parse` | `JSON.parse()` results must stay `unknown` until validated. |
| `no-reflect-outside-allowlist` | `Reflect.*` only in explicitly allowlisted boundary files. |
| `no-object-shape-cast-from-unknown` | No `as { ... }` casts on `unknown` values. |
| `no-dynamic-import` | Disallows runtime `import(...)`. |
| `no-inline-import-type` | Disallows `type X = import("./x").X` — use regular imports. |
| `no-redundant-check-after-typebox` | No extra runtime checks after `Value.Check()`/`Value.Parse()`. |
| `no-redundant-runtime-narrowing` | No `typeof`/`Array.isArray`/`in` checks already proven by same-file TS types. |
| `no-inline-error-message-extraction` | No repeating `error instanceof Error ? error.message : String(error)`. |
| `no-local-unknown-record-helper` | No redefining `asRecord`/`readString` helpers locally. |

These directly enforce the repo's convention of TypeBox schemas at boundaries and TypeScript narrowing over defensive runtime checks in internal code. When lint complains, fix the code shape rather than fighting the rule. See `support/oxlint-plugin-project-rules/README.md`.

## Pre-reply quality gates

Per the root `AGENTS.md`, run before finishing a change and fix failures, rerunning until green:

```bash
npm run typecheck
npm test
npm run lint
npm run format:check
```
