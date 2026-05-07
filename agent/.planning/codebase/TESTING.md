# Testing Patterns

**Analysis Date:** 2026-05-07

## Test Framework

**Runner:**

- Vitest `^4.1.5`
- Config: `vitest.config.ts`
- `vitest.config.ts` sets `dir: "test"`, `include: ["**/*.test.ts"]`, and `setupFiles: ["./test/test-utils/setup-env.ts"]`.
- The config uses `forks` pool execution, caps workers at 6 locally and 1 in GitHub Actions, and raises the timeout to 30s on GitHub Actions.
- Reporters are `minimal` and `json`, and coverage writes to `.tmp/coverage`.

**Assertion Library:**

- Vitest `expect`

**Run Commands:**

```bash
npm test
npm run test:watch
npm run test:coverage
```

## Test File Organization

**Location:**

- Tests are centralized under `test/`, not co-located with source.
- Main suites use `*.test.ts`, for example `test/harness.test.ts`, `test/gsd/lifecycle.test.ts`, and `test/subagent.test.ts`.
- Scenario helpers and data modules use `*.scenarios.ts` or supporting `*.ts` files, for example `test/review-helpers.scenarios.ts`, `test/subagent-sdk-spawn.scenarios.ts`, and `test/tool-preview-scenarios.ts`.
- Some suites are split into thin loader files and scenario modules, such as `test/review.test.ts` importing `review-parse.scenarios.ts`, `review-flow.scenarios.ts`, and `review-helpers.scenarios.ts`.
- Shared setup helpers live in `test/test-utils/`, especially `test/test-utils/setup-env.ts` and `test/test-utils/timed-test.ts`.

**Naming:**

- Test names describe behavior in sentence form: `"returns null when required env missing"`, `"notify falls back to stdout when tmux write fails"`, `"spawnRole waits for completion"`.
- Longer integration suites use a domain label in `describe(...)`, such as `"interview public url"`, `"gsd subagents"`, or `"review command autocompletes targets, flags, branches, and commits"`.

**Structure:**

```text
test/
├── *.test.ts
├── *.scenarios.ts
└── test-utils/
    ├── setup-env.ts
    └── timed-test.ts
```

## Test Structure

**Suite Organization:**

```typescript
import { afterEach, expect, test, vi } from "vitest";

const timedTest: typeof test = ((name: string, fn: (...args: any[]) => any) =>
  test(name, { timeout: TEST_TIMEOUT_MS }, fn)) as typeof test;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

timedTest("notify falls back to stdout when tmux write fails", () => {
  expect(true).toBe(true);
});
```

**Patterns:**

- Group by module or feature with `describe(...)` when the file has multiple related behaviors, as in `test/interview-public-url.test.ts`, `test/gsd/schema.test.ts`, and `test/terminal-notify.test.ts`.
- Use bare `test(...)` for small files and a local `timedTest` wrapper for slower suites.
- Keep test bodies direct; avoid unnecessary helper layers inside simple assertion files.
- Favor explicit assertions over snapshots. No snapshot framework is detected in `test/`.

## Mocking

**Framework:**

- Vitest mocks: `vi.fn`, `vi.spyOn`, `vi.useFakeTimers`, `vi.restoreAllMocks`.

**Patterns:**

```typescript
vi.spyOn(terminalNotifyRuntime, "execFileSync").mockReturnValue("/dev/ttys009\n");
vi.spyOn(terminalNotifyRuntime, "writeFileSync").mockImplementation(() => undefined);
const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

notify("π", "done");

expect(stdoutSpy).not.toHaveBeenCalled();
```

```typescript
const spawn = vi.fn().mockResolvedValue({
  ok: true,
  value: {
    handle: {
      waitForCompletion: vi.fn().mockResolvedValue({
        sessionId: "session-id",
        status: "completed",
        summary: "done",
      }),
      captureOutput: vi.fn().mockResolvedValue({ text: "captured output" }),
    },
  },
});
```

**What to Mock:**

- External process boundaries and shell commands: `execFileSync`, `execFile`, tmux adapters, and child-session launch paths in `test/terminal-notify.test.ts`, `test/subagent-launch.test.ts`, and `test/review.test.ts`.
- Filesystem and temporary directories when the behavior under test depends on layout or cleanup, as in `test/gsd/lifecycle.test.ts` and `test/interview-regressions.test.ts`.
- Harness adapters and extension APIs when testing orchestration, for example `FakeMuxAdapter`, `FakePi`, and `createTestSession(...)` in `test/harness.test.ts` and `test/subagent.test.ts`.
- Timers for UI shimmer or polling behavior, as in `test/coreui-working-message.test.ts`.

**What NOT to Mock:**

- The parser or helper under test when the behavior is pure and cheap, e.g. `Value.Check(...)` tests in `test/gsd/schema.test.ts`.
- Real behavior that the test depends on, such as config writes, state persistence, or emitted events. Mock the narrow boundary only.
- Avoid mocking so high up that you erase the side effect the assertion needs to observe.

## Fixtures and Factories

**Test Data:**

```typescript
function createRoot(): string {
  return mkdtempSync(join(tmpdir(), "agent-gsd-lifecycle-"));
}

function createContext(cwd: string): ExtensionCommandContext {
  return {
    cwd,
    hasUI: false,
    ui: { notify: vi.fn() },
    sessionManager: { getSessionId: () => "parent-session-id" },
  } as unknown as ExtensionCommandContext;
}
```

**Location:**

- Test factories are usually local to each file when they are specific to one suite, e.g. `createMapCodebaseSpawn(...)` in `test/gsd/lifecycle.test.ts` and `createFakeContext(...)` in `test/subagent-sdk-spawn.scenarios.ts`.
- Shared setup lives in `test/test-utils/setup-env.ts`, which creates a temp `PI_CODING_AGENT_DIR` for test isolation.
- Longer suites often define fake adapters inline: `FakeMuxAdapter`, `HarnessMuxAdapter`, and `FakePi` appear repeatedly in `test/subagent*.ts`, `test/review.test.ts`, and `test/harness.test.ts`.

## Coverage

**Requirements:**

- No explicit coverage threshold is detected.
- Coverage is available through `npm run test:coverage`.
- Coverage output is written to `.tmp/coverage` and includes `src/**/*.ts` while excluding `test/**/*.ts`, as configured in `vitest.config.ts`.

**View Coverage:**

```bash
npm run test:coverage
```

## Test Types

**Unit Tests:**

- Pure helpers, schema validation, formatting, and small adapters.
- Examples: `test/gsd/schema.test.ts`, `test/interview-public-url.test.ts`, `test/terminal-notify.test.ts`, `test/pi-tui-keys.test.ts`.

**Integration Tests:**

- Orchestration, filesystem, process, and session flows.
- Examples: `test/harness.test.ts`, `test/gsd/lifecycle.test.ts`, `test/subagent.test.ts`, `test/review.test.ts`.

**E2E Tests:**

- Not detected as a separate runner.
- The broad harness and lifecycle suites serve as end-to-end coverage for the extension system.

## Common Patterns

**Async Testing:**

```typescript
await waitForCondition(() => sdk.list().length === 1);
await vi.advanceTimersByTimeAsync(2_500);
await expect(result.waitForResult()).resolves.toEqual({ ... });
```

**Error Testing:**

```typescript
await expect(spawnRole(...)).rejects.toThrow(/ended with status failed: child crashed/);
expect(Value.Check(PlanningConfigSchema, invalidValue)).toBe(false);
```

**Lifecycle Cleanup:**

```typescript
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  unregisterBuiltInModes(TEST_MODE_SOURCE);
});
```

**Environment Isolation:**

- Tests set or restore env vars explicitly, especially `PI_CODING_AGENT_DIR`, `TMUX`, and SSH-related markers.
- Temporary directories are created with `mkdtemp(...)` / `mkdtempSync(...)` and removed in `finally` blocks or `afterEach` hooks.

---

_Testing analysis: 2026-05-07_
