# project-rules

Repo-local Oxlint JS plugin for enforcing project-specific rules that built-in rules do not cover.

## Why this exists

This project has rules that are more specific than generic TypeScript or Oxlint guidance:

- no dynamic `import()`
- no inline import types
- no `Reflect.*` outside approved boundary files
- no direct `fetch` under `src/remote/`; use typed Hono RPC instead
- no redundant runtime narrowing when same-file TypeScript types already prove shape
- no redundant checks after TypeBox validation
- no object-shape casts from `unknown`
- no direct typed use of `JSON.parse(...)`
- no repeated inline error-message ternaries
- no repeated local unknown-record helper definitions

This plugin lives in-repo under `support/` so rules can evolve with project code and conventions.

## Why alternative API

Plugin uses Oxlint alternative API via `eslintCompatPlugin(...)` and `createOnce(...)`.

Benefits:

- compatible with Oxlint JS plugin model
- future-proof for upcoming Oxlint performance work
- still ESLint-compatible if needed later

Reference docs:

- <https://oxc.rs/docs/guide/usage/linter/writing-js-plugins.html#alternative-api>
- <https://oxc.rs/docs/guide/usage/linter/js-plugins>

## Rules

### `project-rules/no-dynamic-import`

Disallows runtime `import(...)`.

Bad:

```js
const module = await import("./thing.js");
```

Good:

```js
import { thing } from "./thing.js";
```

### `project-rules/no-inline-import-type`

Disallows inline import type syntax.

Bad:

```ts
type State = import("./types.js").State;
```

Good:

```ts
import type { State } from "./types.js";
```

### `project-rules/no-reflect-outside-allowlist`

Disallows `Reflect.*` unless current file is explicitly allowlisted.

Use this only for true boundary helpers that must touch upstream-private internals.

### `project-rules/no-direct-fetch-in-remote`

Disallows direct `fetch(...)` in remote code.

Use typed Hono RPC routes and clients instead.

### `project-rules/no-redundant-runtime-narrowing`

Disallows runtime checks that are already proven by same-file TypeScript annotations.

Current supported checks:

- redundant `typeof`
- redundant `Array.isArray(...)`
- redundant `"prop" in value`

Bad:

```ts
function render(name: string) {
  if (typeof name === "string") {
    return name.toUpperCase();
  }
  return name;
}
```

```ts
function readUser(user: { id: string; name: string }) {
  if ("id" in user) {
    return user.id;
  }
  return "";
}
```

Good:

```ts
function render(name: string) {
  return name.toUpperCase();
}
```

Boundary validation remains valid when value starts as `unknown`.

### `project-rules/no-redundant-check-after-typebox`

Disallows extra object/typeof/array checks after a successful `Value.Check(...)` or `Value.Parse(...)` already validated the same value.

Current behavior:

- catches `const parsed = Value.Parse(Schema, value)` followed by redundant checks on `parsed`
- catches `if (!Value.Check(Schema, value)) return` followed by redundant checks on `value`
- catches `if (Value.Check(Schema, value)) { ... }` redundant checks inside that success branch
- catches the same success-branch patterns even when the branch body is a single non-block statement
- works whether `Schema` is local or imported from another file

Intentional limit:

- it does not inspect schema contents across files
- it only trusts control flow proven in current file
- it only treats post-`if` code as validated when the failure branch definitely aborts

### `project-rules/no-object-shape-cast-from-unknown`

Disallows using `as { ... }` or `as Partial<...>` on values that started as `unknown` just to probe fields.

Current behavior:

- flags inline object-shape casts like type literals, mapped types, interface bodies, and intersections
- does not flag arbitrary named type references just because they were imported or aliased

### `project-rules/no-unsafe-json-parse`

Requires `JSON.parse(...)` results to stay `unknown` until validated.

### `project-rules/no-inline-error-message-extraction`

Disallows repeating inline `error instanceof Error ? error.message : String(error)` logic.

### `project-rules/no-local-unknown-record-helper`

Disallows redefining common local helpers like `asRecord(value: unknown)` and `readString(value: unknown)` instead of reusing shared boundary helpers.

Current behavior:

- skips only explicit shared helper modules that intentionally define reusable boundary readers
- does not broadly exempt every `shared.ts` or `utils.ts` file

## Allowlists

Some rules accept `allowFiles`.

Use allowlists only for intentional boundary files. Do not use them to hide normal code smells.

## Limits

Oxlint JS plugins are not TypeScript type-aware yet.

Because of that, redundant narrowing rule is intentionally conservative:

- same-file types only
- direct local annotations only
- no cross-file imported type resolution
- no call-site flow analysis

If a case is not provable locally, rule should stay quiet.

## Expected config shape

Add plugin under `jsPlugins` in `.oxlintrc.json`:

```json
{
  "jsPlugins": ["./support/oxlint-plugin-project-rules/index.mjs"]
}
```

Then enable desired rules.

## Verification

After wiring config:

```bash
npm run typecheck
npm test
npm run lint
npm run format:check
```
