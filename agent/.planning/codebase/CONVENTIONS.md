# Coding Conventions

**Analysis Date:** 2026-05-05

## Naming Patterns

**Files:**

- Feature code uses kebab-case filenames inside feature folders, for example `src/extensions/coreui/tools-bash.ts`, `src/extensions/gsd/state/read.ts`, `src/extensions/executor/tools.ts`, and `src/subagent-sdk/runtime.ts`.
- Feature roots expose `index.ts` barrels, for example `src/extensions/files/index.ts`, `src/extensions/modes/index.ts`, `src/extensions/patch/index.ts`, and `src/subagent-sdk/index.ts`.
- Entry-point wrappers stay thin and usually live at the feature root, for example `src/extensions/coreui.ts`, `src/extensions/gsd/index.ts`, `src/extensions/files.ts`, and `src/extensions/executor/index.ts`.
- Tests use `*.test.ts` and support modules use `*.scenarios.ts`, for example `test/executor.test.ts`, `test/review.test.ts`, `test/tool-preview-scenarios.ts`, and `test/review-flow.scenarios.ts`.
- Shared test helpers live in `test/test-utils/*.ts`, for example `test/test-utils/setup-env.ts` and `test/test-utils/timed-test.ts`.
- Type declarations use `*.d.ts`, for example `src/extension-event-augmentation.d.ts`.

**Functions:**

- Use camelCase for helpers and verbs for actions, for example `parseGsdCommandArgs`, `buildAvailableModesPromptGuidelines`, `registerCoreUIToolOverrides`, and `formatNotification`.
- Use `create*` for factories, `register*` for wiring, `parse*` for validation, `read*` for file access, `build*` for derived data, `format*` for rendering, `resolve*` for lookup, and `load*` for I/O that returns cached or derived state.
- Use `is*` for predicates and guards, for example `isExecutorToolDetails`, `isSshSession`, and `isReviewStateActiveOnBranch`.
- Default-export extension entrypoints stay thin and only wire event handlers, for example `src/extensions/coreui.ts`, `src/extensions/gsd/index.ts`, `src/extensions/files.ts`, and `src/extensions/executor/index.ts`.

**Variables:**

- Local values use camelCase, for example `projectName`, `planningContext`, `activeTools`, and `timedTest`.
- Shared constants use uppercase snake case, for example `TEST_TIMEOUT_MS` and `GITHUB_ACTIONS_TEST_TIMEOUT_MS`.
- Boolean locals and properties read like questions, for example `hasUI`, `enabled`, `valid`, `isError`, and `isBinary`.
- Abbreviations are kept short and familiar where they are domain terms, for example `pi`, `ctx`, `cwd`, and `mcpUrl`.

**Types:**

- Use PascalCase for interfaces, aliases, and schema-backed types, for example `ExecutorEndpoint`, `PlanningSnapshot`, `ToolPreviewScenario`, and `HarnessMuxAdapter`.
- TypeBox schemas use the `Schema` suffix, for example `PlanningConfigSchema`, `StateFrontmatterSchema`, and `PlanFrontmatterSchema`.
- Parsed or normalized data stays separate from schemas when the final shape differs after validation, for example `PlanningConfig`, `StateFrontmatter`, and `ExecuteToolDetails`.

## Code Style

**Formatting:**

- Formatting is handled by `oxfmt` through `package.json` scripts, not by a separate repo formatter config.
- TypeScript is strict in `tsconfig.json` with `strict`, `noImplicitAny`, `noFallthroughCasesInSwitch`, `forceConsistentCasingInFileNames`, and `verbatimModuleSyntax` enabled.
- Source files use ESM with `"type": "module"` in `package.json` and `NodeNext` resolution in `tsconfig.json`.

**Linting:**

- Linting is handled by `oxlint` with `.oxlintrc.json` and the custom project rules in `support/oxlint-plugin-project-rules/index.mjs`.
- Production code avoids dynamic `import()`, inline import types, unsafe `JSON.parse` handling, `Reflect.*` outside allowlisted files, redundant runtime narrowing, redundant checks after TypeBox validation, and object-shape casts from `unknown`.
- Production code avoids `any`; tests are excluded from oxlint, so local test fakes may use pragmatic casts when the harness needs to mirror upstream APIs.

**Type Safety:**

- Treat boundary data as `unknown` until validated with TypeBox or a small guard, for example `src/extensions/gsd/state/read.ts`, `src/extensions/gsd/state/schema.ts`, and `src/extensions/executor/tools.ts`.
- Use `Value.Check(...)` before accepting structured data from files, session state, tool output, and env-derived payloads.
- Use shared helpers from `src/utils/unknown-data.ts` instead of ad hoc record casts when reading loose boundary data.

## Import Organization

**Order:**

1. External packages first, for example `@mariozechner/pi-coding-agent`, `typebox`, `vitest`, and `strip-ansi`.
2. Node builtins next, for example `node:fs`, `node:path`, `node:os`, and `node:http`.
3. Internal relative imports last, for example `./state/read.js`, `../utils/unknown-data.js`, and `./coreui/tools.js`.

**Path Aliases:**

- Not detected. Source imports use explicit relative paths with `.js` suffixes under `src/`.
- Test files import source modules with explicit relative paths that often end in `.ts`, matching NodeNext resolution in the test runner.

## Error Handling

**Patterns:**

- Return `undefined`, a safe default, or a typed parse result for recoverable boundary cases, for example `readPlanningConfig` and `parseGsdSettings` in `src/extensions/gsd/state/read.ts` and `src/extensions/gsd/state/schema.ts`.
- Throw direct `Error` instances for unrecoverable validation failures with contextual messages, for example `parsePlanningConfig` in `src/extensions/gsd/state/schema.ts` and `resolveExecutorEndpoint` in `src/extensions/executor/connection.ts`.
- Centralize error-message normalization in `src/utils/error-message.ts` and use it in runtime glue like `src/extensions/executor/index.ts` and `src/extensions/executor/connection.ts`.
- Use domain-specific error classes for multi-attempt failure reporting, for example `ExecutorUnavailableError` in `src/extensions/executor/connection.ts`.
- Catch only expected upstream or lifecycle failures at integration boundaries, then surface a user notification via `ctx.ui.notify(...)`, for example `src/extensions/executor/index.ts` and `src/extensions/files.ts`.

## Logging

**Framework:** `ctx.ui.notify(...)` for user-facing status, with rare direct console usage in low-level adapters and bootstrap code.

**Patterns:**

- Prefer structured UI notifications over console output when a user is present, for example `src/extensions/gsd/commands.ts`, `src/extensions/files.ts`, and `src/extensions/executor/index.ts`.
- Use console output only for low-level fallback or diagnostics, not for normal user flow.

## Comments

**When to Comment:**

- Comments are sparse and usually reserved for module headers or short file-level context, for example `src/extensions/files.ts`.
- Most implementation files stay comment-light and rely on named helpers and small functions.

**JSDoc/TSDoc:**

- There is no broad JSDoc convention. Public helpers are usually self-describing by name and type.

## Function Design

**Size:**

- Keep functions small and single-purpose. Larger workflows are split into helpers, especially in `src/extensions/coreui.ts`, `src/extensions/gsd/state/read.ts`, and `src/extensions/executor/tools.ts`.
- The lint ceilings in `.oxlintrc.json` are `128` lines per function and `750` lines per file, so monolithic implementations should be split before they hit those limits.

**Parameters:**

- Prefer explicit object parameters for multi-field inputs, especially in command handlers, render helpers, and tool factories.
- Keep boundary-facing parameters typed as `unknown` or schema-backed types until validation is complete.

**Return Values:**

- Return small objects with named fields for derived state, for example `resolveExecutorEndpoint` in `src/extensions/executor/connection.ts` and `readPlanningSnapshot` in `src/extensions/gsd/state/read.ts`.
- Return `undefined` for unsupported or malformed optional data rather than propagating nullable unions through the whole call chain.

## Module Design

**Exports:**

- Feature modules expose a default extension factory plus named helpers for tests and reuse, for example `src/extensions/coreui.ts`, `src/extensions/review.ts`, and `src/extensions/gsd/index.ts`.
- Shared utilities are re-exported through feature barrels, for example `src/extensions/coreui/tools.ts` and `src/subagent-sdk/index.ts`.

**Barrel Files:**

- Barrel files are common at feature roots and should be used when adding a new feature subtree, for example `src/extensions/modes/index.ts`, `src/extensions/files/index.ts`, and `src/extensions/patch/index.ts`.

---

_Convention analysis: 2026-05-05_
