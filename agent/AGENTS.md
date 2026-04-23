# @shekohex/agent

A TypeScript-based wrapper around `@mariozechner/pi-coding-agent` that bundles team defaults, custom extensions, and additional providers.

## Project Overview

This package provides:

- The upstream `pi` TUI experience
- Built-in LiteLLM support with automatic gateway selection
- Bundled providers for `codex-openai` and `zai-coding-plan`
- Bundled themes (including Catppuccin)
- A bundled prompt set
- Custom extensions for web search, file operations, executor integration, and more

## Project Rules

- You must use `@sinclair/typebox` package instead of manually parsing inputs and validation of data.
- Prefere spliting your code into multiple modules so it can be reused.
- Avoid dynamic imports when possible, and prefer type imports when possible.
- Client and Server interaction Must be using Hono RPC instead of calling `fetch` directly.
- No `any` types unless absolutely necessary
- Check node_modules for external API type definitions instead of guessing
- **NEVER use inline imports** - no `await import("./foo.js")`, no `import("pkg").Type` in type positions, no dynamic imports for types. Always use standard top-level imports.
- NEVER remove or downgrade code to fix type errors from outdated dependencies; upgrade the dependency instead
- Always ask before removing functionality or code that appears to be intentional
- Do not preserve backward compatibility unless the user explicitly asks for it

### Type Safety Rules

DO:

- Use TypeScript types and narrowing first for internal application code.
- Use `@sinclair/typebox` schemas for payloads that cross boundaries:
  - client/server RPC payloads
  - persisted JSON/JSONL state
  - tool inputs and outputs
  - env-derived structured config
  - external API responses when shape matters
- Use `Value.Check(...)` for validation and `Value.Parse(...)` only when parsed value is plain data and safe to clone.
- Prefer explicit type guards, discriminated unions, `in` checks, and small helper functions over dynamic property access.
- Keep unknown data as `unknown` until validated.
- Prefer typed Hono RPC clients over manual URL construction or ad-hoc route traversal.

DON'T:

- Don't use unsafe type assertions like `as Foo`, double assertions, or broad casts to silence TypeScript.
- Don't use `any` unless there is no alternative and user explicitly accepts it.
- Don't use dynamic typing patterns for normal internal code paths.
- Don't add runtime type guards, `in` checks, or defensive method-existence checks for public APIs that are already fully typed in our code path. Trust TypeScript unless data crossed an untyped boundary.
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
- Don't use `Reflect` for client/server payload validation. Use TypeBox there.

### Hono RPC Rules

DO:

- Use Hono RPC client objects directly when typed route access works.
- If Hono RPC proxy behavior forces dynamic access for a route segment, isolate that workaround to one boundary helper only.

DON'T:

- Don't replace Hono RPC with raw `fetch`.
- Don't manually assemble RPC URLs when a typed Hono client can represent the route.

## Development Commands

### Build

```bash
npm run build
```

Compiles TypeScript, copies bundled resources, generates default settings, and prepares CLI binaries.

### Run Locally

```bash
npm run pi                    # Run pi locally
npm run pi -- -p "hello"      # Run with a prompt
```

### Linting

```bash
npm run lint                  # Run oxlint
npm run lint:fix              # Run oxlint with auto-fix
```

Uses [oxlint](https://oxc.rs/docs/guide/usage/linter.html) with TypeScript, Unicorn, and OXC plugins. Configuration in `.oxlintrc.json`.

### Formatting

```bash
npm run format                # Format with oxfmt
npm run format:check          # Check formatting without modifying files
```

Uses [oxfmt](https://github.com/oxc-project/oxc) for formatting.

### Typechecking

```bash
npm run typecheck
```

## Task Completion

After finishing each task, run these checks before replying:

```bash
npm typecheck
npm test
npm run lint
npm run format:check
```

If there any errors, please fix them and rerun the workflow again.

### Test Framework

Tests use **Node.js built-in test runner** (`node:test` and `node:assert/strict`).

Key testing patterns:

1. **Test Harness**: Uses `@marcfargas/pi-test-harness` for integration testing

   ```typescript
   import { createTestSession, calls, says, when } from "@marcfargas/pi-test-harness";

   const session = await createTestSession({
     cwd: "/tmp/test",
     extensionFactories: [myExtension],
   });

   await session.run(
     when("Test scenario", [calls("toolName", { arg: "value" }), says("Expected response")]),
   );
   ```

2. **Mocking Tools**: Mock specific tools while keeping others real

   ```typescript
   const session = await createTestSession({
     mockTools: {
       bash: ({ command }) => `ran: ${command}`,
     },
   });
   ```

3. **HTTP Servers for Integration**: Create local HTTP servers to test external API calls

   ```typescript
   const server = createServer((req, res) => { ... });
   await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
   // Test against server
   await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
   ```

4. **Timeout Pattern**: Tests use a 15-second timeout

   ```typescript
   const TEST_TIMEOUT_MS = 15_000;
   const timedTest: typeof test = ((name: string, fn: (...args: any[]) => any) =>
     test(name, { timeout: TEST_TIMEOUT_MS }, fn)) as typeof test;
   ```

5. **Temp Directory Pattern**: Use `mkdtemp` for isolated test environments
   ```typescript
   const cwd = await mkdtemp(join(tmpdir(), "test-prefix-"));
   try {
     // ... test code
   } finally {
     await rm(cwd, { recursive: true, force: true });
   }
   ```

### Test File Naming

- Test files: `*.test.ts`
- Test utilities: `*.scenarios.ts`
- Located in `/test` directory

## Extension Development

Extensions follow the `@mariozechner/pi-coding-agent` Extension API:

```typescript
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";

const myExtension: ExtensionFactory = () => (pi: ExtensionAPI) => {
  pi.registerTool({
    name: "myTool",
    execute: async (id, args, ctx) => { ... },
  });

  pi.on("session_start", async (event, ctx) => { ... });
};
```

## Upstream Patches

Uses `patch-package` to maintain patches on `@mariozechner/pi-coding-agent`. After upgrading:

1. Reapply patches: `npm run patch:deps`
2. Test: `npm run test:tool-preview && npm run test:harness`
3. Rebuild: `npm run build`

## External Repos.

Load the `librarian` skill and then you an search the following repos:

- `badlogic/pi-mono`: whenever you need to get the source code for the pi coding agent and any other package releated to pi.
- `durable-streams/durable-streams`: when you need to learn anything about `durable-streams`
- `honojs/hono`: anything hono http server, client or middleware releated.
- `anomalyco/opencode`: when the user mention opencode, or any opencode releated things.
