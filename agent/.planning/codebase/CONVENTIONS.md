# Coding Conventions

**Analysis Date:** 2026-05-07

## Naming Patterns

**Files:**

- Feature modules use kebab-case filenames inside domain folders, e.g. `src/extensions/interview/server-runtime.ts`, `src/subagent-sdk/persistence-helpers.ts`, and `src/utils/unknown-data.ts`.
- Tests live in `test/` and use the `*.test.ts` suffix, e.g. `test/terminal-notify.test.ts`, `test/gsd/lifecycle.test.ts`, and `test/subagent-launch.test.ts`.
- Scenario-style helpers use `*.scenarios.ts`, e.g. `test/review-helpers.scenarios.ts`, `test/subagent-sdk-spawn.scenarios.ts`, and `test/tool-preview-scenarios.ts`.

**Functions:**

- Use camelCase verbs that describe the action: `registerGsdCommands`, `buildLaunchCommand`, `parseBodyWithSchema`, `resolveCoderPublicBaseUrl`, `readChildState`.
- Predicate helpers start with `is`, `has`, `should`, or `can`, e.g. `isRecord`, `hasSubstantiveArtifactBody`, `isAutoExitTimeoutModeActive`.
- Parsing helpers start with `parse` and boundary conversion helpers start with `read`, `resolve`, or `normalize`.

**Variables:**

- Use descriptive camelCase for local state and parameters: `sessionDir`, `childStateArgument`, `registeredToolNames`, `launchTarget`.
- Boolean constants and capability lists are explicit and readable: `TEST_TIMEOUT_MS`, `SUBAGENT_DEBUG_ENV_ALLOWLIST`, `documentsByFocus`.

**Types:**

- Use PascalCase for exported types, interfaces, schemas, and classes: `RuntimeSubagent`, `SubagentToolParamsSchema`, `InterviewServerHandle`, `BodyTooLargeError`.
- Use literal unions and TypeBox schemas for external or persisted shapes instead of ad-hoc structural typing.

## Code Style

**Formatting:**

- Formatting is enforced through `oxfmt` via `npm run format` / `npm run format:check`.
- No repo-local Prettier or Biome config is detected; rely on the formatter defaults used by the scripts in `package.json`.
- Keep semicolons, double quotes, and trailing commas in multiline literals and argument lists, matching files such as `src/subagent-sdk/launch.ts` and `test/terminal-notify.test.ts`.

**Linting:**

- Linting is handled by `oxlint` through `npm run lint`.
- No repo-local ESLint config is detected; use the script-defined lint gate instead of inventing new style rules.
- Favor explicit imports and small helpers over complex inline logic so lint output stays simple and readable.

## Import Organization

**Order:**

1. Node built-ins, when present, e.g. `node:fs`, `node:path`, `node:os` in `src/extensions/interview/server-runtime.ts` and `src/subagent-sdk/launch.ts`.
2. Third-party packages, with `import type` where possible, e.g. `typebox`, `vitest`, `@mariozechner/pi-coding-agent`, `@marcfargas/pi-test-harness`.
3. Local modules last, grouped by relative path and kept with `.js` suffix in TypeScript source, e.g. `./types.js`, `../src/extensions/gsd/subagents.js`.

**Path Aliases:**

- Not detected. Use relative imports.
- Local TypeScript imports use `.js` extensions because the project runs with `moduleResolution: "NodeNext"` in `tsconfig.json`.

## Error Handling

**Patterns:**

- Parse boundary data with `TypeBox` + `Value.Check(...)`/`Value.Parse(...)` before trusting it. See `src/extensions/interview/schema.ts`, `src/subagent-sdk/types.ts`, and `src/subagent-sdk/schema-definitions.ts`.
- Return `undefined` or `null` for optional or invalid external data when the caller can recover, e.g. `readChildState()` in `src/subagent-sdk/launch.ts` and `readEphemeralChildSessionOutcomeBySessionId()` in `src/subagent-sdk/persistence.ts`.
- Throw `new Error(...)` for invariant failures and impossible states, e.g. `throw new Error("Failed to allocate child session path")` in `src/subagent-sdk/persistence.ts` and `throw new Error("Missing default theme assets")` in `src/extensions/interview/server-assets.ts`.
- Normalize unknown exceptions through tiny helpers such as `errorMessage(error)` in `src/utils/error-message.ts` and `getErrorMessage(error)` in `src/extensions/interview/errors.ts`.
- Use best-effort `try/catch {}` only for cleanup or fallback paths where failure should not crash the feature, such as recovery-file maintenance in `src/subagent-sdk/persistence.ts` and asset loading fallbacks in `src/extensions/interview/server-assets.ts`.

## Logging

**Framework:**

- No centralized logging package detected.
- `src/extensions/interview/server-assets.ts` uses a local `log(verbose, message)` helper that writes to `process.stderr` with a `[interview]` prefix.

**Patterns:**

- Prefer structured, context-specific logging helpers over ad-hoc console spam.
- Use `console.warn` / `console.error` only for narrow fallback or diagnostic paths, such as `src/extensions/modes/flags.ts` and `src/extensions/session-breakdown/ui.ts`.
- Keep verbose output gated behind explicit flags or debug env vars, as seen in the interview server and subagent runtime code.

## Comments

**When to Comment:**

- Keep comments rare. Prefer descriptive names, small helpers, and clear module boundaries.
- Comment only when a protocol, file format, or compatibility rule is not obvious from the code, such as the hard validation rules in `src/extensions/interview/schema.ts` or the launch-file protocol in `src/subagent-sdk/launch.ts`.

**JSDoc/TSDoc:**

- Sparse. The codebase favors named exports and readable helper names over large doc blocks.
- Use inline descriptions in TypeBox schema definitions where the runtime contract matters, as shown in `src/subagent-sdk/schema-definitions.ts`.

## Function Design

**Size:**

- Keep functions focused and small. Large workflows are split into helper functions in the same module or neighboring files, e.g. `src/extensions/interview/server-runtime.ts`, `src/extensions/gsd/lifecycle/map-codebase.ts`, and `src/subagent-sdk/launch.ts`.
- Use early returns to flatten control flow.

**Parameters:**

- Prefer object parameters when a function needs several inputs or has evolving options, e.g. `buildLaunchCommand(state, childState, prompt, options)` and `createFakeContext(options)` in tests.
- Keep data flow explicit at boundary helpers; avoid hidden globals except for deliberate module-level caches or constants.

**Return Values:**

- Return `undefined`/`null` for missing optional results.
- Return structured objects for successful boundary conversions and validation helpers.
- Throw only when the caller cannot reasonably recover.

## Module Design

**Exports:**

- Prefer named exports.
- Keep public surfaces small and re-export from barrels when a module is a feature entrypoint, such as `src/extensions/index.ts`, `src/extensions/coreui/tools.ts`, and `src/subagent-sdk/types.ts`.
- Use `default` exports sparingly, mainly for extension factories or single-purpose modules.

**Barrel Files:**

- Barrel-style re-exports exist for feature surfaces, especially under `src/extensions/` and `src/subagent-sdk/`.
- Keep barrel files thin; they should re-export, not implement business logic.

---

_Convention analysis: 2026-05-07_
