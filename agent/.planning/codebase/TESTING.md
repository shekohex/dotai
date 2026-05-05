# Testing Patterns

**Analysis Date:** 2026-05-05

## Test Framework

**Runner:**

- Vitest 4.1.5 from `vitest`.
- Config: `vitest.config.ts`.
- Test pool: `forks`, with `maxWorkers` reduced to `1` on GitHub Actions.
- Test files discovered by Vitest are `test/**/*.test.ts` only; `*.scenarios.ts` files are support modules imported by those specs.

**Assertion Library:**

- Vitest `expect` assertions.

**Run Commands:**

```bash
npm test
npm run test:watch
npm run test:coverage
```

## Test File Organization

**Location:**

- Primary tests live in `test/` and use domain-based filenames like `test/gsd/commands.test.ts`, `test/coreui-editor.test.ts`, and `test/subagent.test.ts`.
- Nested folders mirror feature structure, for example `test/gsd/`, `test/test-utils/`, and `test/gsd/fixtures/`.
- Shared test helpers live in `test/test-utils/`, especially `test/test-utils/setup-env.ts` and `test/test-utils/timed-test.ts`.
- Scenario data and reusable scripted flows live beside tests as `*.scenarios.ts`, for example `test/review-flow.scenarios.ts`, `test/review-helpers.scenarios.ts`, and `test/tool-preview-scenarios.ts`.
- Fixtures for planning-tree state live under `test/gsd/fixtures/...` and are copied into temp workspaces during brownfield tests.

**Naming:**

- Use `*.test.ts` for Vitest-discovered specs.
- Use descriptive sentence-style test names, for example `"review command keeps quoted folder paths intact"` in `test/review.test.ts` and `"executor tools re-register after session restart with same cwd"` in `test/executor.test.ts`.

**Structure:**

```text
test/
├── coreui-editor.test.ts
├── gsd/
│   ├── commands.test.ts
│   ├── lifecycle.test.ts
│   └── fixtures/
├── review.test.ts
└── test-utils/
    ├── setup-env.ts
    └── timed-test.ts
```

## Test Structure

**Suite Organization:**

```ts
const timedTest: typeof test = ((name: string, fn: (...args: any[]) => any) =>
  test(name, { timeout: TEST_TIMEOUT_MS }, fn)) as typeof test;

timedTest("notify writes passthrough sequence to tmux pane tty", () => {
  process.env.TMUX = "/tmp/tmux-1000/default,123,0";
  vi.spyOn(terminalNotifyRuntime, "execFileSync").mockReturnValue("/dev/ttys009\n");
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

  notify("π", "done");

  expect(stdoutSpy).not.toHaveBeenCalled();
});
```

**Patterns:**

- Use `describe` / `it` for small pure-unit suites, especially schema and parser tests like `test/gsd/schema.test.ts`, `test/openusage-pace.test.ts`, and `test/coreui-tps.test.ts`.
- Use `test` or the shared `timedTest` wrapper for longer integration cases, especially harness, subagent, and session-level tests.
- Build focused helper factories inside the test file when setup is non-trivial, for example `createHandoffTestProviders`, `HarnessMuxAdapter`, `FakePi`, and `createExecutorProbeServer` in `test/harness.test.ts`, `test/subagent.test.ts`, and `test/executor.test.ts`.
- Use polling helpers such as `waitForAssertion` when behavior completes asynchronously after file or session events in `test/harness.test.ts` and `test/review.test.ts`.
- Keep setup and cleanup local to the test body, usually with `try/finally` around temp dirs, sessions, and fake servers.

## Mocking

**Framework:**

- Vitest `vi.fn`, `vi.spyOn`, `vi.restoreAllMocks`, and manual fake implementations.

**Patterns:**

```ts
const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
vi.spyOn(terminalNotifyRuntime, "execFileSync").mockReturnValue("/dev/ttys009\n");
```

```ts
const spawn = vi.fn().mockResolvedValue({
  ok: true,
  value: { handle: { waitForCompletion: vi.fn(), captureOutput: vi.fn() } },
});
```

**What to Mock:**

- Mock external process boundaries, for example `tmux`, `git`, `gh`, and `process.stdout.write` in `test/terminal-notify.test.ts` and `test/review.test.ts`.
- Mock network boundaries with local HTTP servers or `globalThis.fetch` replacements, for example `test/harness.test.ts`, `test/executor.test.ts`, and `test/tool-preview.test.ts`.
- Mock `ExtensionAPI`, `ExtensionContext`, and `MuxAdapter` with small in-file fakes when exercising extension logic.
- Use `createTestSession` from `@marcfargas/pi-test-harness` when the real tool and event pipeline matter, for example `test/harness.test.ts`, `test/subagent.test.ts`, and `test/review.test.ts`.

**What NOT to Mock:**

- Do not mock the behavior under test when the real integration is the point, for example `apply_patch`, `webfetch`, `websearch`, `executor`, and subagent runtime paths.
- Prefer real temp files, real session events, and real command registration over synthetic shortcuts when validating behavior across boundaries.

## Fixtures and Factories

**Test Data:**

```ts
const root = await mkdtemp(join(tmpdir(), "agent-review-command-"));
await mkdir(join(root, ".pi"), { recursive: true });
await writeFile(join(root, ".pi", "modes.json"), `${JSON.stringify(data, null, 2)}\n`, "utf8");
```

**Location:**

- Shared fixture trees live in `test/gsd/fixtures/`.
- Per-test scratch data is created with `mkdtemp`, `mkdtempSync`, `mkdir`, `mkdirSync`, `writeFile`, and `writeFileSync` in the test body.
- Small helper builders live near the test that uses them, not in a global fixture library.
- `test/test-utils/setup-env.ts` sets `PI_CODING_AGENT_DIR` and `TEST_PI_CODING_AGENT_DIR` to isolate session state for the whole run.

## Coverage

**Requirements:**

- No explicit threshold detected in `vitest.config.ts` or `package.json`.
- Coverage output is configured to `.tmp/coverage` via Vitest with the V8 provider.
- Coverage includes `src/**/*.ts` and excludes `test/**/*.ts`.

**View Coverage:**

```bash
npm run test:coverage
```

## Test Types

**Unit Tests:**

- Fast pure tests cover schemas, parsers, formatters, and state reducers, for example `test/gsd/schema.test.ts`, `test/openusage-pace.test.ts`, `test/coreui-tps.test.ts`, and `test/terminal-notify.test.ts`.

**Integration Tests:**

- Session-level and file-system tests use the real extension pipeline via `createTestSession`, temp dirs, fake binaries, and local HTTP servers.
- These tests dominate `test/harness.test.ts`, `test/review.test.ts`, `test/subagent.test.ts`, and `test/interview-regressions.test.ts`.

**E2E Tests:**

- Not used as a separate framework tier. The closest equivalent is the harness-driven integration suite in `test/harness.test.ts`.

## Common Patterns

**Async Testing:**

```ts
await waitForAssertion(() => {
  expect(pickedSummaries.length).toBe(1);
});
await session.session.agent.waitForIdle();
await expect(access(join(serverDir, "note.txt"))).rejects.toThrow();
```

**Error Testing:**

```ts
expect(() => {
  intervalCallback?.();
}).not.toThrow();

await expect(
  spawnRole({} as ExtensionAPI, createContext(createRoot()), "executor", "execute"),
).rejects.toThrow(/ended with status failed/);
```

**Assertions:**

- Use `toEqual`, `toContain`, `toMatch`, and `toBeTruthy` for most checks.
- Use `expect.arrayContaining(...)` and `expect.objectContaining(...)` for command completion, spawned process arguments, and structured outputs.
- Use exact error text or regex on failure cases when message wording is part of the contract.

---

_Testing analysis: 2026-05-05_
