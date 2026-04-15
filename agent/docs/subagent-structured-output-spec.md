# Subagent Structured Output Spec

## Scope

This spec captures the current findings from the `opencode` and `pi-mono` codebases and defines the intended subagent structured-output design for our codebase.

## Findings

### `opencode`

- `StructuredOutput` is implemented as a synthetic tool, not as a provider-native JSON-only mode.
- The tool is injected only when the user requests `format.type === "json_schema"`.
- The session prompt adds an instruction that the model must call the `StructuredOutput` tool as its final response.
- The model request is still a normal tool-calling request; the provider receives `tools` and `toolChoice: "required"` through the AI SDK.

Relevant paths:

- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/llm.ts`
- `packages/opencode/src/session/message-v2.ts`
- `packages/opencode/src/provider/sdk/copilot/chat/openai-compatible-chat-language-model.ts`

Observed behavior:

- `lastUser.format?.type === "json_schema"` injects `tools["StructuredOutput"]`.
- `createStructuredOutputTool()` uses the JSON Schema as the tool input schema.
- The tool `execute()` captures the parsed args into local state.
- If the assistant finishes without calling the tool, `StructuredOutputError` is stored on the assistant message.

### `pi-mono`

- `pi-ai` does not have a first-class structured-output API today.
- Tools are already schema-backed and validated with TypeBox.
- The agent loop already supports preflight and postflight hooks around tool execution.
- The coding-agent / subagent stack already uses synthetic summaries and structured tool-style state where needed.

Relevant paths:

- `packages/ai/src/types.ts`
- `packages/agent/src/types.ts`
- `packages/agent/src/agent-loop.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/compaction/branch-summarization.ts`
- `packages/coding-agent/src/core/compaction/compaction.ts`
- `packages/coding-agent/examples/extensions/subagent/index.ts`

Observed behavior:

- A tool is defined as `{ name, description, parameters }` and `parameters` is a TypeBox schema.
- The agent validates tool args before execution.
- `beforeToolCall` can block a tool call.
- `afterToolCall` can mutate the emitted tool result.
- The current `subagent` extension already exposes a rich tool with structured `details`, but it does not support caller-requested structured output yet.

### Our subagent SDK

- Our current subagent SDK spawns child sessions, manages tmux, and returns a text summary when the child finishes.
- The child outcome is currently reduced to `summary?: string`.
- The `subagent` tool returns text content plus rich `details`, but the runtime does not yet carry a caller-requested output schema.

Relevant paths:

- `src/subagent-sdk/types.ts`
- `src/subagent-sdk/sdk.ts`
- `src/subagent-sdk/runtime.ts`
- `src/subagent-sdk/persistence.ts`
- `src/subagent-sdk/launch.ts`
- `src/subagent-sdk/bootstrap.ts`
- `src/extensions/subagent.ts`
- `docs/subagent-sdk.md`

## Goal

Allow a parent caller to spawn a subagent and request structured output using a TypeBox JSON Schema.

The subagent should:

- receive the output format schema as part of its spawn contract,
- be instructed to call a synthetic structured-output tool as its final turn,
- capture the tool input as structured output,
- return that structured output to the original caller,
- retry if the model fails to call the tool or emits invalid payloads,
- fail with a typed error after the retry budget is exhausted.

The TypeScript API should preserve the schema in the returned result type as much as possible.

## Proposed Design

### Core idea

Use the same pattern as `opencode`:

- define a synthetic `StructuredOutput` tool on the fly,
- attach the caller-provided TypeBox schema to the tool input schema,
- inject a system prompt that requires the model to call the tool as the last turn,
- capture the tool input in the tool execution handler,
- treat missing tool calls as a retryable failure,
- store the captured structured object on the subagent terminal state.

### Runtime flow

1. Parent caller spawns a subagent with an optional `outputFormat`.
2. The subagent runtime serializes the format into the child bootstrap state.
3. The child session injects a synthetic `StructuredOutput` tool if a JSON schema was requested.
4. The child session adds a system instruction requiring the tool to be called as the final action.
5. The agent runs normally.
6. If the assistant calls the tool, the tool captures the parsed object.
7. If the assistant ends without calling the tool, the runtime retries the turn.
8. Retry count defaults to `3`.
9. After retry exhaustion, the runtime returns an error to the original caller.
10. The parent receives either structured data or a typed error.

### Event hooks

We can hook into agent lifecycle events:

- `agent turn` start/end
- `agent end`

At `agent end`, if no structured tool call was observed, the runtime can force a retry by asking the agent to call the tool with the structured input.

### Result shape

The returned value should be a discriminated union that carries the error as a value:

```ts
type SpawnOutcome<T, E> = { ok: true; value: T } | { ok: false; error: E };
```

For structured subagent output:

```ts
type StructuredSubagentOutcome<T> = SpawnOutcome<T, StructuredOutputError>;
```

The error branch should include:

- retry count exhausted,
- validation failures,
- aborted execution,
- model failure to call the synthetic tool.

## API Sketch

### Spawn input

```ts
type OutputFormat<TSchema extends TSchemaBase = TSchemaBase> =
  | { type: "text" }
  | { type: "json_schema"; schema: TSchema; retryCount?: number };

type StartSubagentParams<TSchema extends TSchemaBase = TSchemaBase> = {
  name: string;
  task: string;
  mode?: string;
  handoff?: boolean;
  cwd?: string;
  autoExit?: boolean;
  outputFormat?: OutputFormat<TSchema>;
};
```

### Spawn overloads

```ts
type StartSubagentParamsText = {
  name: string;
  task: string;
  mode?: string;
  handoff?: boolean;
  cwd?: string;
  autoExit?: boolean;
  outputFormat?: { type: "text" };
};

type StartSubagentParamsJsonSchema<TSchema extends TSchemaBase> = {
  name: string;
  task: string;
  mode?: string;
  handoff?: boolean;
  cwd?: string;
  autoExit?: boolean;
  outputFormat: { type: "json_schema"; schema: TSchema; retryCount?: number };
};

type StartSubagentResultText = SpawnOutcome<StartSubagentBaseResult, StructuredOutputError>;

type StartSubagentResultJsonSchema<TSchema extends TSchemaBase> = SpawnOutcome<
  StartSubagentBaseResult & { structured: Static<TSchema> },
  StructuredOutputError
>;

type StartSubagentBaseResult = {
  state: RuntimeSubagent;
  prompt: string;
};

interface SubagentSDK {
  spawn(params: StartSubagentParamsText): Promise<StartSubagentResultText>;
  spawn<TSchema extends TSchemaBase>(
    params: StartSubagentParamsJsonSchema<TSchema>,
  ): Promise<StartSubagentResultJsonSchema<TSchema>>;
}
```

### Subagent terminal state

Extend the persisted runtime state to carry the structured payload:

```ts
type RuntimeSubagent = {
  ...
  summary?: string;
  structured?: unknown;
  outputFormat?: OutputFormat;
};
```

## TypeScript Typing Goal

The caller should get schema-derived output typing when they pass a schema.

Example:

```ts
const result = await sdk.spawn({
  name: "worker",
  task: "Summarize the repo",
  outputFormat: {
    type: "json_schema",
    schema: Type.Object({
      summary: Type.String(),
      risk: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
    }),
  },
});

if (result.ok) {
  result.value.summary;
  result.value.risk;
} else {
  result.error;
}
```

This should be expressed as overloads on `spawn()` so the resolved return type depends on `outputFormat`.

Behavior:

- `outputFormat: { type: "text" }` returns the base spawn result shape.
- `outputFormat: { type: "json_schema", schema }` returns the same base shape plus `structured` typed from the schema.
- In both cases, the resolved value should be a discriminated union that carries `error` as a value.

## Retry Semantics

- Default retry count: `3`.
- Retry when the model fails to call the structured-output tool.
- Retry when the tool input fails schema validation.
- Stop retrying after the configured budget is exhausted.
- Return a typed error to the parent caller on exhaustion.

The default retry count should be the runtime default unless the caller overrides it in `outputFormat.retryCount`.

## Implementation Notes

### Where to add behavior

- `src/subagent-sdk/types.ts`
  - Add `outputFormat` types.
  - Add structured output result/error types.
  - Add persisted `structured` payload on runtime state.
- `src/subagent-sdk/runtime.ts`
  - Inject the synthetic tool into the child launch path.
  - Track structured output capture and retry status.
  - Return typed structured results or typed errors.
- `src/subagent-sdk/persistence.ts`
  - Persist structured-output state across restarts.
- `src/subagent-sdk/launch.ts`
  - Pass the requested output format to the child bootstrap payload.
- `src/subagent-sdk/bootstrap.ts`
  - Activate child behavior based on the bootstrap payload.
- `src/extensions/subagent.ts`
  - Expose structured-output-aware tool behavior to the parent agent.
- `docs/subagent-sdk.md`
  - Document the new spawn contract and the result typing.

### How it differs from provider-native structured output

This design does not require provider-native `response_format` support.

It relies on:

- normal tool calling,
- a schema-backed synthetic tool,
- runtime capture of tool input,
- retry logic in our agent layer.

That keeps the feature portable across providers.

## Open Questions

1. Should structured output be available on `spawn()` only, or also on `message()` and `resume()`?
2. Should the parent caller receive `structured` and `summary`, or should structured output replace summary when requested?
3. Should the error type distinguish between validation failure, missing tool call, and abort?
4. Should the subagent keep retrying only on `agent end`, or also immediately after a tool-less assistant turn?
5. Should the synthetic tool be named `StructuredOutput` exactly, or should it be namespaced under subagent?

## Recommendation

Implement the synthetic-tool approach first.

Reason:

- matches the existing `opencode` pattern,
- works across all providers supported by `pi-ai`,
- keeps the contract in TypeScript and schema-first,
- avoids needing provider-specific output-format support in `pi-ai` immediately,
- is the smallest change that satisfies the desired parent-subagent structured output workflow.
