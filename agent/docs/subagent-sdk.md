# Subagent SDK Developer Guide

The Subagent SDK provides a programmatic interface for spawning, managing, and orchestrating child pi sessions. It decouples the subagent runtime from the CLI tool, allowing extensions to consume lifecycle management, persistence, and tmux orchestration directly.

The SDK was developed through an iterative refactoring of the original `subagent` CLI tool into a robust, programmatic SDK. Key milestones included:

- **Decoupling**: Separated the runtime from CLI commands to allow direct SDK consumption by extensions
- **State Protection**: Implemented cloned snapshots to prevent external mutation of internal state
- **Event Deduplication**: Added signature-based deduplication to prevent noisy UI churn from poll-only `updatedAt` changes
- **Review Integration**: The `/review` extension served as the primary production-grade validation of the SDK

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [SDK API Reference](#sdk-api-reference)
- [Best Practices](#best-practices)
- [Code Examples](#code-examples)
- [Mode Integration](#mode-integration)

---

## Architecture Overview

The SDK consists of three primary layers:

### 1. SDK Layer (`sdk.ts`)

The public-facing API that extensions interact with. Key responsibilities:

- **State Protection**: Returns cloned snapshots of internal state to prevent external mutation. This was a critical design decision made during SDK refactoring to prevent extensions from accidentally corrupting runtime state.
- **Event Deduplication**: Uses `SubagentRuntimeEventBus` to emit events only when state actually changes. Signatures are computed from `{event, status, paneId, completedAt, autoExitDeadlineAt, autoExitTimeoutActive, summary, structured, structuredError, exitCode}` to filter out poll-only `updatedAt` churn.
- **Handle Abstraction**: Provides `SubagentHandle` instances for ergonomic interaction with specific subagents, eliminating the need to pass `sessionId` manually for every operation

```
Extension Code
      |
      v
  SubagentSDK (createSubagentSDK)
      |
      +-- spawn() -> SpawnOutcome<{ handle, prompt } | { handle, prompt, state, structured }, StructuredOutputError>
      +-- message() -> SubagentHandle
      +-- cancel() -> RuntimeSubagent
      +-- onEvent() -> unsubscribe
```

### 2. Runtime Layer (`runtime.ts`)

The orchestration engine managing subagent lifecycles:

- **Persistence Integration**: Persists state to the parent session file via hooks
- **Pane Management**: Tracks tmux pane lifecycle, auto-detects pane death
- **Polling**: Periodic sync of live subagent status (every 2s when active)
- **State Machine**: Manages transitions between `running` -> `idle` -> `completed|failed|cancelled`

### 3. Adapter Layer (`mux.ts`, `tmux.ts`)

Abstraction over terminal multiplexers:

- `MuxAdapter` interface allows swapping tmux for other backends
- `TmuxAdapter` implements pane creation, text injection, capture, and destruction
- Handles `steer`, `followUp`, and `nextTurn` delivery modes

### Data Flow

```
spawn(params)
    |
    v
resolveSubagentMode() -> mode config (tools, systemPrompt, autoExit)
    |
    v
buildLaunchCommand() -> shell command with env payload
    |
    v
adapter.createPane() -> tmux pane with child pi process
    |
    v
SubagentRuntime.poll() -> monitors pane, syncs status
    |
    v
finalizeInactiveSubagent() -> reads outcome, persists terminal state
```

---

## SDK API Reference

### Creating the SDK

```typescript
import { createSubagentSDK } from "./subagent-sdk/sdk.js";
import { TmuxAdapter } from "./subagent-sdk/tmux.js";
import { buildLaunchCommand } from "./subagent-sdk/launch.js";

const sdk = createSubagentSDK(pi, {
  adapter: new TmuxAdapter((cmd, args, opts) => pi.exec(cmd, args, opts), process.cwd()),
  buildLaunchCommand,
  hooks: customHooks, // optional
});
```

### Core Methods

#### `spawn(params, ctx, onUpdate?, signal?)`

Starts a new subagent session.

```typescript
const result = await sdk.spawn(
  {
    name: "worker-1",
    task: "Implement user authentication",
    mode: "worker",
    cwd: "/path/to/project",
    handoff: true, // Generate context transfer summary
  },
  ctx,
  (update) => {
    // Progress updates: handoff generation, launch
    console.log(update.details.statusText);
  },
  abortSignal, // Optional cancellation
);

if (!result.ok) {
  throw new Error(result.error.message);
}

const { handle, prompt } = result.value;
```

**Returns:**

- `ok: true` with `value.handle` and `value.prompt` for text output mode
- `ok: false` with a typed structured-output error for aborted startup/structured failures

### Structured Results

When `outputFormat.type` is `json_schema`, `spawn()` waits for terminal completion and returns structured output validated through the synthetic `StructuredOutput` tool flow.

```typescript
const result = await sdk.spawn(
  {
    name: "risk-worker",
    task: "Summarize current release risk",
    outputFormat: {
      type: "json_schema",
      schema: Type.Object({
        summary: Type.String(),
        risk: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
      }),
      retryCount: 3,
    },
  },
  ctx,
);

if (result.ok) {
  result.value.structured.summary;
  result.value.structured.risk;
} else {
  result.error.code;
  result.error.message;
}
```

Structured-mode failures resolve as `ok: false` (no throw), using these error codes:

- `missing_tool_call`
- `validation_failed`
- `retry_exhausted`
- `aborted`

### Spawn Outcome Pattern

For SDK consumers that call `spawn()` frequently, use a small helper to keep outcome handling explicit and consistent.

```typescript
function unwrapSpawn<T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return result.value;
}

const started = unwrapSpawn(
  await sdk.spawn({ name: "worker", task: "Investigate flaky tests", mode: "worker" }, ctx),
);

const handle = started.handle;
```

#### `message(params, ctx, onUpdate?)`

Sends a message to an existing subagent. Auto-resumes if the pane is dead.

```typescript
const { handle, result } = await sdk.message(
  {
    sessionId: handle.sessionId,
    message: "Add password validation",
    delivery: "steer", // "steer" | "followUp" | "nextTurn"
  },
  ctx,
);

// result.autoResumed: true if pane was recreated
// result.resumePrompt: prompt used if auto-resumed
```

#### `cancel(params)`

Kills the tmux pane and marks subagent as cancelled.

```typescript
const terminalState = await sdk.cancel({ sessionId: handle.sessionId });
```

#### `restore(ctx)`

Recovers subagent states from persisted session entries after extension reload.

```typescript
const handles = await sdk.restore(ctx);
// Reconnects to live panes, finalizes dead ones
```

#### `list()`

Returns all subagent states (cloned snapshots).

```typescript
const states = sdk.list();
// Array of RuntimeSubagent, sorted by startedAt
// RuntimeSubagent now includes optional structured/outputFormat/structuredError fields
```

#### `get(sessionId)`

Gets a handle for a specific subagent if it exists.

```typescript
const handle = sdk.get(sessionId);
if (handle) {
  const state = handle.getState();
}
```

### SubagentHandle Methods

Each handle provides scoped operations:

```typescript
// Get current state (cloned)
const state = handle.getState();

// Send message (convenience wrapper around sdk.message)
const result = await handle.sendMessage({ message: "Update", delivery: "steer" }, ctx);

// Cancel this subagent
const terminalState = await handle.cancel();

// Wait for terminal status with optional abort signal
const finalState = await handle.waitForCompletion({ signal: abortSignal });
// finalState.structured is set when child captured structured output

// Capture recent output from tmux pane
const capture = await handle.captureOutput(100); // last 100 lines

// Subscribe to events for this specific subagent
const unsubscribe = handle.onEvent((event) => {
  console.log(event.type, event.state.status);
});
```

### Event Subscription

Global event stream for all subagents:

```typescript
const unsubscribe = sdk.onEvent((event) => {
  // event.type: "started" | "resumed" | "updated" | "completed" | "failed" | "cancelled"
  // event.state: RuntimeSubagent
});

// Cleanup
unsubscribe();
sdk.dispose(); // Stops polling, clears timers
```

---

## Best Practices

The `/review` extension demonstrates production-grade SDK usage:

### Target-Specific Prompt Composition

The review extension builds prompts dynamically based on target type. This pattern emerged from production use where different review targets (uncommitted, branch, commit, PR, folder) require distinct instructions:

```typescript
async function buildReviewPrompt(pi: ExtensionAPI, target: ReviewTarget): Promise<string> {
  switch (target.type) {
    case "uncommitted":
      return "Review the current code changes (staged, unstaged, untracked)...";
    case "baseBranch": {
      const mergeBase = await getMergeBase(pi, target.branch);
      return mergeBase
        ? BASE_BRANCH_PROMPT_WITH_MERGE_BASE
            .replace(/{baseBranch}/g, target.branch)
            .replace(/{mergeBaseSha}/g, mergeBase)
        : BASE_BRANCH_PROMPT_FALLBACK.replace(/{branch}/g, target.branch);
    }
    case "pullRequest": {
      const mergeBase = await getMergeBase(pi, target.baseBranch);
      return mergeBase
        ? PULL_REQUEST_PROMPT
            .replace(/{prNumber}/g, String(target.prNumber))
            .replace(/{title}/g, target.title)
            .replace(/{baseBranch}/g, target.baseBranch)
            .replace(/{mergeBaseSha}/g, mergeBase)
        : PULL_REQUEST_PROMPT_FALLBACK.replace(...);
    }
    // ... folder, commit cases
  }
}
```

**Key insights from production:**

- Compose the task prompt separately from mode configuration; the SDK merges them appropriately
- Always include concrete git commands (e.g., `git diff {mergeBaseSha}`) in prompts so the subagent knows exactly how to inspect changes
- Merge base resolution prevents reviewing unrelated history when comparing branches
- Fallback prompts handle cases where merge-base cannot be determined

### Using `--handoff` for Context Bridge

Handoff generates a summary of parent session context for the child:

```typescript
const result = await sdk.spawn(
  {
    name: "review",
    task: reviewPrompt,
    mode: "review",
    handoff: true, // Triggers context summarization
  },
  ctx,
  (update) => {
    if (update.details.phase === "handoff") {
      // Show progress while LLM summarizes context
      console.log(update.details.preview); // Partial summary
    }
  },
);

if (!result.ok) {
  throw new Error(result.error.message);
}

const { handle, prompt } = result.value;
```

The handoff process:

1. Collects conversation messages from parent session
2. Generates summary focused on the task goal
3. Injects parent session path for `session_query` access
4. Child can reference parent with: "If you need additional detail from the parent session, use `session_query`..."

For custom handoff generation (e.g., with UI loader):

```typescript
const handoffResult = await generateContextTransferSummaryWithLoader(
  ctx,
  goal,
  messages,
  "Generating review handoff...",
);
```

### Managing Child Sessions Without Manual tmux

The SDK abstracts all tmux operations. The review extension:

1. **Spawns without managing pane IDs:**

```typescript
const started = await sdk.spawn({ name: "review", task, mode: "review" }, ctx);
if (!started.ok) throw new Error(started.error.message);
// Pane created automatically, ID stored in state
```

2. **Monitors via events, not polling tmux:**

```typescript
stopSdkEvents = sdk.onEvent((event) => {
  if (event.state.sessionId !== runtime.subagentSessionId) return;
  syncReviewWidget(ctx);
  if (["completed", "failed", "cancelled"].includes(event.state.status)) {
    void finalizeReview(ctx, event.state.status);
  }
});
```

3. **Auto-cleanup on completion:**

```typescript
async function finalizeReview(ctx: ExtensionContext, status: string) {
  clearReviewState(ctx);
  await restoreCheckoutTarget(pi, checkoutToRestore);
  ctx.ui.notify(status === "completed" ? "Review complete." : "Review failed.");
}
```

4. **Restores state across extension reloads:**

```typescript
pi.on("session_start", async (_event, ctx) => {
  await sdk.restore(ctx);
  applyReviewState(ctx); // Re-hydrate local runtime from SDK state
});
```

### Session Anchoring Pattern

The review extension anchors to the current branch to avoid manual navigation branches and `/end-review` command complexity. This pattern was developed to handle the case where users copy or navigate sessions independently:

```typescript
// Create anchor entry in session history
pi.appendEntry(REVIEW_ANCHOR_TYPE, {
  targetLabel,
  createdAt: new Date().toISOString(),
});
const branchAnchorId = ctx.sessionManager.getLeafId() ?? undefined;

// Persist with anchor reference
persistReviewState({
  active: true,
  subagentSessionId: started.value.handle.sessionId,
  targetLabel,
  branchAnchorId, // Used to detect if user navigated away
  checkoutToRestore, // For PR reviews: git state before gh checkout
});

// Check if still valid on restore
function isReviewStateActive(
  state: ReviewSessionState,
  branchEntries: Array<{ id?: string }>,
): state is ReviewSessionState {
  if (!state?.active) return false;
  if (!state.branchAnchorId) return true; // Legacy fallback
  return branchEntries.some((entry) => entry.id === state.branchAnchorId);
}
```

**Why this matters:** Without anchoring, copied or mismatched branches would incorrectly report as having an active review. The anchor ensures review state is only considered active when the branch entry with that specific ID exists in the current branch lineage.

**PR Review Cleanup Pattern:**
When reviewing PRs, `gh pr checkout` mutates the working tree before the review branch is created. The extension records the original checkout target and restores it on cleanup:

```typescript
type ReviewCheckoutTarget = { type: "branch"; name: string } | { type: "detached"; commit: string };

// Before checkout
const checkoutToRestore = await getCurrentCheckoutTarget(pi);

// ... spawn review subagent ...

// On finalizeReview
await restoreCheckoutTarget(pi, checkoutToRestore);
```

---

## Code Examples

### Basic Extension Using the SDK

```typescript
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createSubagentSDK } from "./subagent-sdk/sdk.js";
import { TmuxAdapter } from "./subagent-sdk/tmux.js";
import { buildLaunchCommand } from "./subagent-sdk/launch.js";
import { createDefaultSubagentRuntimeHooks } from "./subagent-sdk/runtime-hooks.js";

const WORKER_WIDGET_KEY = "my-worker";

export function createWorkerExtension() {
  return function workerExtension(pi: ExtensionAPI) {
    // Create SDK instance
    const adapter = new TmuxAdapter((cmd, args, opts) => pi.exec(cmd, args, opts), process.cwd());

    const sdk = createSubagentSDK(pi, {
      adapter,
      buildLaunchCommand,
      hooks: {
        ...createDefaultSubagentRuntimeHooks(pi),
        emitStatusMessage({ content }) {
          // Custom status handling
          pi.sendMessage({ customType: "worker-status", content, display: true });
        },
      },
    });

    // Track active workers
    const workers = new Map<string, { task: string; handle: SubagentHandle }>();

    // Restore on session start
    pi.on("session_start", async (_event, ctx) => {
      const handles = await sdk.restore(ctx);
      for (const handle of handles) {
        const state = handle.getState();
        if (state.status === "running" || state.status === "idle") {
          workers.set(state.sessionId, { task: state.task, handle });
        }
      }
      updateWidget(ctx);
    });

    // Subscribe to events
    sdk.onEvent((event) => {
      if (["completed", "failed", "cancelled"].includes(event.state.status)) {
        workers.delete(event.state.sessionId);
      }
      updateWidget(pi.getContext());
    });

    function updateWidget(ctx: ExtensionContext | undefined) {
      if (!ctx?.hasUI) return;
      const active = Array.from(workers.values()).map((w) => w.handle.getState());
      ctx.ui.setWidget(WORKER_WIDGET_KEY, renderWorkerWidget(active));
    }

    // Register commands
    pi.registerCommand("worker", {
      description: "Spawn a background worker subagent",
      handler: async (args, ctx) => {
        const task = args || "Help with the current task";

        const started = await sdk.spawn(
          {
            name: `worker-${workers.size + 1}`,
            task,
            mode: "worker",
            cwd: ctx.cwd,
            autoExit: true,
          },
          ctx,
          (update) => {
            // Show progress in UI
            if (update.details.preview) {
              ctx.ui.notify(update.details.statusText, "info");
            }
          },
        );

        if (!started.ok) {
          throw new Error(started.error.message);
        }

        const { handle } = started.value;

        workers.set(handle.sessionId, { task, handle });
        updateWidget(ctx);

        ctx.ui.notify(`Worker started: ${handle.sessionId.slice(0, 8)}`);
      },
    });

    pi.registerCommand("worker-message", {
      description: "Send message to a worker",
      handler: async (args, ctx) => {
        const [sessionIdShort, ...messageParts] = args.split(" ");
        const message = messageParts.join(" ");

        // Find by prefix match
        const entry = Array.from(workers.entries()).find(([id]) => id.startsWith(sessionIdShort));

        if (!entry) {
          ctx.ui.notify("Worker not found", "error");
          return;
        }

        const [, { handle }] = entry;
        await handle.sendMessage({ message, delivery: "steer" }, ctx);

        ctx.ui.notify("Message sent");
      },
    });

    pi.on("session_shutdown", () => {
      sdk.dispose();
    });
  };
}
```

### Waiting for Completion

```typescript
async function runSequentialTasks(ctx: ExtensionContext, tasks: string[]) {
  const results = [];

  for (const task of tasks) {
    const started = await sdk.spawn({ name: "sequential-worker", task, mode: "worker" }, ctx);
    if (!started.ok) {
      results.push({ task, status: "failed", error: started.error.message });
      continue;
    }

    const { handle } = started.value;

    try {
      // Wait for completion with timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000); // 5 min

      const finalState = await handle.waitForCompletion({
        signal: controller.signal,
      });

      clearTimeout(timeout);
      results.push({ task, status: finalState.status, summary: finalState.summary });

      // Capture output for logging
      const capture = await handle.captureOutput(50);
      console.log(`Task output:\n${capture.text}`);
    } catch (error) {
      if (error.message === "Cancelled") {
        await handle.cancel();
      }
      results.push({ task, status: "failed", error: error.message });
    }
  }

  return results;
}
```

### Custom Mode with Specific Tools

Modes configure the subagent environment through markdown files with YAML frontmatter. The `review` mode is the canonical production example:

```markdown
---
tools:
  - read
  - bash
  - websearch
  - session_query
autoExit: true
autoExitTimeoutMs: 30000
tmuxTarget: pane
systemPrompt: |
  You are acting as a reviewer for a proposed code change...
systemPromptMode: append
---

# Review Guidelines

You are acting as a reviewer for a proposed code change made by another engineer...

## Determining What To Flag

...
```

Using the custom mode:

```typescript
const started = await sdk.spawn(
  {
    name: "planner",
    task: "Plan the authentication system implementation",
    mode: "planner", // Resolves to modes/planner.md
    cwd: ctx.cwd,
  },
  ctx,
);
if (!started.ok) {
  throw new Error(started.error.message);
}

const { handle } = started.value;
```

**Design insight:** Modes consolidate system prompt, tool selection, auto-exit behavior, and tmux target in a single file. This was inspired by the need to have review-specific guidelines that differ from general coding assistance.

---

## Mode Integration

Modes configure the subagent environment through markdown files with YAML frontmatter.

### Mode File Structure

```markdown
---
# Tool selection (array of rules)
tools:
  - "*" # Include all parent tools
  - "!subagent" # Except subagent (always excluded)
  - "read" # Explicitly include read
  - "!write" # Exclude write

# Lifecycle behavior
autoExit: true # Exit when idle
autoExitTimeoutMs: 30000 # Idle timeout (default: 30000)

# UI target
tmuxTarget: pane # "pane" | "window"

# Model override (optional)
provider: openai
modelId: gpt-4o

# Thinking level (optional)
thinkingLevel: high # "low" | "medium" | "high"

# System prompt handling
systemPrompt: |
  You are a code reviewer. Focus on security and correctness.
systemPromptMode: append # "append" | "replace"
---

# Additional markdown content (context, examples, etc.)
```

### Mode Resolution

Modes are resolved by `resolveSubagentMode()` in `modes.ts`:

1. **Lookup:** Mode name maps to `modes/{name}.md`
2. **Inheritance:** If not found and name is "worker", uses synthetic default
3. **Tool Resolution:** Rules applied in order: `*` expands to parent tools, `!` excludes, explicit includes add
4. **Override:** SDK params (`autoExit`, `cwd`) take precedence over mode defaults

### Synthetic Worker Mode

Default when no mode specified or "worker" not found:

```typescript
const syntheticWorkerMode: ModeSpec = {
  tools: ["*", "!subagent"], // All parent tools except subagent
  autoExit: true,
};
```

### Tool Resolution Rules

```typescript
// Example: Parent has ["read", "edit", "bash", "subagent", "websearch"]
// Mode tools: ["*", "!subagent", "write"]
// Result: ["bash", "edit", "read", "websearch", "write"]

const rules = ["*", "!subagent", "write"];
for (const rule of rules) {
  if (rule === "*") {
    // Add all parent tools
  } else if (rule.startsWith("!")) {
    // Remove specific tool
  } else {
    // Add specific tool
  }
}
// Always filtered to remove "subagent"
```

### Runtime Hooks

Customize persistence and notifications:

```typescript
const hooks: SubagentRuntimeHooks = {
  async persistState(state) {
    // Custom persistence (default: pi.appendEntry)
    await myDatabase.saveSubagent(state);
  },

  async persistMessage(entry) {
    // Track message delivery
    await myDatabase.saveMessage(entry);
  },

  emitStatusMessage({ content, triggerTurn }) {
    // Custom status emission
    myLogger.info(content);
    pi.sendMessage({ customType: "status", content });
  },

  renderWidget(ctx, subagents) {
    // Custom widget rendering
    if (!ctx?.hasUI) return;
    ctx.ui.setWidget("custom", myRenderer(subagents));
  },
};
```

### Launch Command Building

The `buildLaunchCommand` function constructs the shell command:

```typescript
const command = buildLaunchCommand(
  state, // RuntimeSubagent (pane title, etc.)
  childState, // ChildBootstrapState (env payload)
  prompt, // Final task prompt
  {
    launchTarget: { kind: "session", sessionPath },
    tmuxTarget: "pane",
    mode: "review",
    model: "openai/gpt-4o",
    systemPrompt: "...",
    systemPromptMode: "append",
  },
);

// Results in:
// env PI_SUBAGENT_CHILD_STATE='{...}' node pi.js --session /path/to/session.jsonl \
//   --model 'openai/gpt-4o' --review 'Implement auth...'
```

---

## Summary

The Subagent SDK provides:

- **Clean abstraction** over tmux and session management - no manual pane ID tracking needed
- **Event-driven** state synchronization with deduplication - based on state signatures, not just timestamps
- **Automatic persistence** via session file entries - survives extension reloads
- **Handoff generation** for context bridging - parent session context summarized for child consumption
- **Mode system** for environment configuration - YAML frontmatter + markdown guidelines
- **Handle-based** ergonomic API for individual subagent control - scoped operations without repetitive sessionId params

## Development History

The SDK evolved through several iterations:

1. **Initial extraction** (`src/extensions/subagent/`): CLI tool implementation with direct tmux calls
2. **SDK decoupling** (`src/subagent-sdk/`): Separated runtime from CLI to allow programmatic use
3. **State protection**: Added cloned snapshots after discovering extensions could mutate shared state
4. **Event deduplication**: Implemented signature-based filtering after UI experienced churn from poll-only updates
5. **Review integration**: Built `/review` extension as the primary production validation, driving features like:
   - Branch anchoring for session scope management
   - `--handoff` flag for context transfer
   - PR checkout/restore for git-native workflows
   - Target-specific prompt composition patterns

For a complete production example, see `src/extensions/review.ts` which implements PR checkout, prompt composition, handoff integration, and automatic cleanup using the full SDK surface.
