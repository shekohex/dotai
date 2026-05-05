# @shekohex/agent

A TypeScript-based wrapper around `@mariozechner/pi-coding-agent` that bundles team defaults, custom extensions, and additional providers.

## Project Rules

- Write instructions around desired outcome, constraints, and verification. Let agent choose efficient path unless exact order matters.
- Keep instruction blocks short. Add detail only when it changes behavior.
- Default voice: direct, steady, respectful. Match user tone without adding fluff.
- Default collaboration style: make progress with reasonable assumptions. Ask only when missing info would materially change result or create meaningful risk.
- For multi-step or tool-heavy work, begin with brief visible update stating first action.
- Use minimum evidence needed for correct answer or action. Search once broadly, then only deepen when key facts are missing, exact artifacts must be read, or user asked for exhaustive coverage.
- After each tool or verification result, decide whether core request is now complete. If yes, stop and answer.
- Do not add extra loops for phrasing, polish, or nonessential citations.
- When editing or rewriting, preserve requested artifact, length, structure, and genre first. Improve clarity without adding unsupported claims.
- Never invent names, metrics, roadmap status, customer outcomes, or capabilities.
- Validate changed behavior before finishing. Prefer targeted checks first, then run repo-wide checks required by this file.
- If a required check cannot run, state why and give next best verification.
- Preserve assistant phase values when replaying prior assistant items into later prompt turns.
- I use speech to text occasionally so if sentences are weird / words aren't right that's why
- code is very cheap to write. do not give time estimates with agents code is practically instant to generate therefore unless stated otherwise time to implement is not a blocker
- You must use `typebox` package instead of manually parsing inputs and validation of data.
- Prefere spliting your code into multiple modules so it can be reused.
- Avoid dynamic imports when possible, and prefer type imports when possible.
- No `any` types unless absolutely necessary
- Check node_modules for external API type definitions instead of guessing
- **NEVER use inline imports** - no `await import("./foo.js")`, no `import("pkg").Type` in type positions, no dynamic imports for types. Always use standard top-level imports.
- NEVER remove or downgrade code to fix type errors from outdated dependencies; upgrade the dependency instead
- Always ask before removing functionality or code that appears to be intentional
- Do not preserve backward compatibility unless the user explicitly asks for it

### Type Safety Rules

DO:

- Use TypeScript types and narrowing first for internal application code.
- Trust typed production boundaries. If runtime contract says a method or field exists in our code path, call it directly.
- Keep boundary code honest: let production code reflect actual runtime guarantees rather than test-double limitations.
- Use `typebox` schemas for payloads that cross boundaries:
  - persisted JSON/JSONL state
  - tool inputs and outputs
  - env-derived structured config
  - external API responses when shape matters
- Use `Value.Check(...)` for validation and `Value.Parse(...)` only when parsed value is plain data and safe to clone.
- Prefer explicit type guards, discriminated unions, `in` checks, and small helper functions over dynamic property access.
- Keep unknown data as `unknown` until validated.

DON'T:

- Don't use unsafe type assertions like `as Foo`, double assertions, or broad casts to silence TypeScript.
- Don't use `any` unless there is no alternative and user explicitly accepts it.
- Don't use dynamic typing patterns for normal internal code paths.
- Don't add runtime type guards, `in` checks, or defensive method-existence checks for public APIs that are already fully typed in our code path. Trust TypeScript unless data crossed an untyped boundary.
- Don't weaken or complicate production code to accommodate incomplete mocks or fake test objects.
- Don't add production fallbacks for broken mocks. If a test double violates the real contract, fix the test double.
- Don't add defensive runtime fallbacks for behavior guaranteed by our typed contracts just because tests failed.
- Don't fix test-contract failures in production code when the right fix is to update the test doubles to match the real API.
- Don't parse structured payloads manually if a TypeBox schema should exist.
- Don't use `Value.Parse(...)` on objects that may contain functions, class instances, timers, callbacks, or other non-cloneable runtime values.

### Reflect Rules

DO:

- Use `Reflect.get` / `Reflect.set` only for upstream hidden or private internals that are not safely reachable through normal typed property access.
- Keep every `Reflect` use isolated in the smallest possible helper or patch point.
- Add a short code-local type guard around `Reflect` boundaries so unknown values are validated immediately after access.
- Prefer normal property access as soon as data is back in our own typed code.

DON'T:

- Don't use `Reflect` for our own internal objects, local state, or normal TypeScript-controlled code.
- Don't use `Reflect` as a shortcut to avoid writing proper types or guards.
- Don't spread `Reflect` access through business logic. Contain it at boundary points only.
- Don't use `Reflect` for payload validation. Use TypeBox there.

### Bug workflow (Debugging)

- Start by writing a failing unit test that reproduces the bug.
- Then fix the bug and prove it with passing tests.
- If the bug is in a workflow, create a new end to end test that reproduces the bug and fix it.
- Follow Red, Green, Refactor (TDD).

## Upstream Patches

Uses `patch-package` to maintain patches on `@mariozechner/pi-coding-agent`. After upgrading:

1. Reapply patches: `npm run patch:deps`
2. Test: `npm run test:tool-preview && npm run test:harness`
3. Rebuild: `npm run build`

## External Repos.

When the user mentions upstream pi, assume it is `badlogic/pi-mono` repo, and use the `librarian` skill and then you an search the following repos:

- `badlogic/pi-mono`: whenever you need to get the source code for the pi coding agent and any other package releated to pi.
- `durable-streams/durable-streams`: when you need to learn anything about `durable-streams`
- `anomalyco/opencode`: when the user mention opencode, or any opencode releated things.

## Task Completion

After finishing each task, run these checks before replying:

```bash
npm run typecheck
npm test
npm run lint
npm run format:check
```

If there any errors, please fix them and rerun the workflow again.
