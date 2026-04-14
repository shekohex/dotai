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

## Directory Structure

```
.
├── bin/                    # CLI entry points (pi.js, pi.cmd)
├── dist/                   # Compiled JavaScript output
├── patches/                # patch-package patches for upstream dependencies
├── scripts/                # Build and utility scripts
│   ├── copy-bundled-resources.mjs
│   ├── generate-default-settings.mjs
│   ├── postinstall.mjs
│   ├── prepare-bin.mjs
│   └── preview-tools.ts    # Tool preview harness
├── src/                    # TypeScript source code
│   ├── cli.ts              # Main entry point
│   ├── extensions/         # Extension implementations
│   │   ├── coreui/         # Core UI enhancements
│   │   ├── executor/       # Executor/MCP integration
│   │   ├── openusage/      # Usage tracking providers
│   │   └── subagent/       # Subagent functionality
│   └── resources/          # Bundled resources
│       ├── modes/          # Mode configurations
│       ├── prompts/        # Prompt templates
│       ├── skills/         # Skill definitions
│       ├── system/         # System prompts
│       └── themes/         # Theme files
├── test/                   # Test files
└── package.json
```

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

## Task Completion

After finishing each task, run these checks before replying:

```bash
npm test
npm run lint
npm run format:check
```

If there any errors, please fix them and rerun the workflow again.

## Testing

### Run All Tests

```bash
npm test                      # Runs all test suites
```

### Individual Test Suites

```bash
npm run test:keys             # TUI keybindings tests
npm run test:tool-preview     # Tool preview harness tests
npm run test:executor         # Executor integration tests
npm run test:harness          # pi-test-harness integration tests
npm run test:subagent         # Subagent functionality tests
```

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

## Configuration

### TypeScript

- Target: ES2022
- Module: NodeNext
- Strict mode enabled
- Output: `dist/`
- Source: `src/`

### Environment Variables

- `PI_SKIP_VERSION_CHECK=1`: Skip version check (used in `npm run pi`)
- `OPENAI_API_KEY`: Required for some tests (falls back to "test-key")
- `LITELLM_API_KEY`: For LiteLLM gateway tests

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
