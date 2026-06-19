import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  createDefaultMuxAdapter,
  createSubagentSDK,
  buildLaunchCommand,
} from "../../subagent-sdk/index.js";
import { registerBuiltInGsdModes } from "./modes.js";
import type { GsdRole } from "./roles.js";
import { resolveRoleModeName } from "./roles.js";
import type { RuntimeSubagent, SubagentCompletion, TSchemaBase } from "../../subagent-sdk/types.js";
import { createGsdSubagentRuntimeHooks } from "./ui/subagent-widget.js";
import type { SubagentHandle } from "../../subagent-sdk/sdk.js";

const PlanOutputSchema = Type.Object(
  {
    plans: Type.Array(
      Type.Object(
        {
          plan: Type.String(),
          phase: Type.String(),
          type: Type.String(),
          wave: Type.Union([Type.String(), Type.Number()]),
          depends_on: Type.Array(Type.String()),
          files_modified: Type.Array(Type.String()),
          autonomous: Type.Boolean(),
          must_haves: Type.Array(Type.String()),
          objective: Type.Optional(Type.String()),
          notes: Type.Optional(Type.Array(Type.String())),
          tasks: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  title: Type.String(),
                  files: Type.Array(Type.String()),
                  action: Type.String(),
                  verify: Type.String(),
                  done: Type.String(),
                },
                { additionalProperties: false },
              ),
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type PlanOutput = Static<typeof PlanOutputSchema>;

function matchesPlanOutput(value: unknown): value is PlanOutput {
  return Value.Check(PlanOutputSchema, value);
}

type SpawnSdk = ReturnType<typeof createSubagentSDK>;
type SpawnSdkFactory = (pi: ExtensionAPI) => SpawnSdk;
type SessionScopedSdkEntry = {
  sdk: SpawnSdk;
};
type SessionScopedSdkContext = Pick<ExtensionCommandContext, "cwd" | "sessionManager">;

export type SpawnRoleResult = {
  sessionId: string;
  summary: string | undefined;
  capturedOutput: string | undefined;
};

export type StartRoleResult = {
  sessionId: string;
  handle: SubagentHandle;
};

export type DetachedRoleRunResult = {
  sessionId: string;
  waitForResult: () => Promise<SpawnRoleResult>;
};

let spawnSdkFactory: SpawnSdkFactory = (pi) =>
  createSubagentSDK(pi, {
    adapter: createDefaultMuxAdapter(pi),
    buildLaunchCommand,
    hooks: createGsdSubagentRuntimeHooks(pi),
  });

const sessionScopedSdks = new Map<string, SessionScopedSdkEntry>();

const gsdSubagentNamePrefixes = ["gsd-", "codebase-mapper:", "intel-updater:"];

function clearSessionScopedSdks(): void {
  for (const entry of sessionScopedSdks.values()) {
    entry.sdk.dispose?.();
  }
  sessionScopedSdks.clear();
}

export function disposeGsdSubagentSdkForSession(ctx: SessionScopedSdkContext): void {
  const sessionId = readParentSessionId(ctx);
  const entry = sessionScopedSdks.get(sessionId);
  if (entry === undefined) {
    return;
  }
  entry.sdk.dispose?.();
  sessionScopedSdks.delete(sessionId);
}

function readParentSessionId(ctx: SessionScopedSdkContext): string {
  return ctx.sessionManager?.getSessionId?.() ?? `cwd:${ctx.cwd}`;
}

function createSdk(pi: ExtensionAPI, ctx: ExtensionCommandContext): SpawnSdk {
  const sessionId = readParentSessionId(ctx);
  const existing = sessionScopedSdks.get(sessionId);
  if (existing) {
    return existing.sdk;
  }

  const sdk = spawnSdkFactory(pi);
  sessionScopedSdks.set(sessionId, { sdk });
  return sdk;
}

export function listGsdSubagents(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): RuntimeSubagent[] {
  return createSdk(pi, ctx)
    .list()
    .filter((subagent) =>
      gsdSubagentNamePrefixes.some((prefix) => subagent.name.startsWith(prefix)),
    );
}

function matchesSchema<TSchema extends TSchemaBase>(schema: TSchema, value: unknown): boolean {
  return Value.Check(schema, value);
}

function assertSuccessfulRoleCompletion(
  role: GsdRole,
  terminalState: RuntimeSubagent,
  capturedOutput: string | undefined,
): void {
  if (terminalState.status === "completed") {
    return;
  }

  const outputSuffix =
    capturedOutput === undefined ? "" : `\n\nCaptured output:\n${capturedOutput}`;

  throw new Error(
    `${role} subagent ${terminalState.sessionId} ended with status ${terminalState.status}: ${terminalState.summary ?? "No summary available."}${outputSuffix}`,
  );
}

async function captureRoleOutput(handle: SubagentHandle): Promise<string | undefined> {
  try {
    const captured = await handle.captureOutput(80);
    const normalized = captured.text.trim();
    return normalized.length > 0 ? normalized : undefined;
  } catch {
    return undefined;
  }
}

export async function awaitRoleResult(
  role: GsdRole,
  handle: SubagentHandle,
): Promise<SpawnRoleResult> {
  const terminalState = await handle.waitForCompletion();
  const capturedOutput = await captureRoleOutput(handle);
  assertSuccessfulRoleCompletion(role, terminalState, capturedOutput);
  return {
    sessionId: terminalState.sessionId,
    summary: terminalState.summary,
    capturedOutput,
  };
}

export function setGsdSubagentSdkFactoryForTests(factory: SpawnSdkFactory | undefined): void {
  clearSessionScopedSdks();
  spawnSdkFactory =
    factory ??
    ((pi) =>
      createSubagentSDK(pi, {
        adapter: createDefaultMuxAdapter(pi),
        buildLaunchCommand,
        hooks: createGsdSubagentRuntimeHooks(pi),
      }));
}

async function spawnStructuredRoleInternal<TSchema extends TSchemaBase>(
  pi: ExtensionAPI,
  sdk: SpawnSdk,
  ctx: ExtensionCommandContext,
  role: GsdRole,
  task: string,
  schema: TSchema,
  retryCount = 2,
): Promise<unknown> {
  registerBuiltInGsdModes();
  const outcome = await sdk.spawn(
    {
      name: `gsd-${role}`,
      task,
      mode: resolveRoleModeName(role),
      outputFormat: {
        type: "json_schema",
        schema,
        retryCount,
      },
      contextPrune: { enabled: false },
    },
    ctx,
  );
  if (!outcome.ok) {
    throw new Error(outcome.error.message);
  }
  return outcome.value.structured;
}

export async function spawnRole(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  role: GsdRole,
  task: string,
  options?: { completion?: SubagentCompletion; name?: string },
): Promise<SpawnRoleResult> {
  const started = await startRole(pi, ctx, role, task, options);
  return awaitRoleResult(role, started.handle);
}

export async function startRole(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  role: GsdRole,
  task: string,
  options?: { completion?: SubagentCompletion; name?: string },
): Promise<StartRoleResult> {
  const sdk = createSdk(pi, ctx);
  registerBuiltInGsdModes();
  const outcome = await sdk.spawn(
    {
      name: options?.name ?? `gsd-${role}`,
      task,
      mode: resolveRoleModeName(role),
      completion: options?.completion,
      contextPrune: { enabled: false },
    },
    ctx,
  );
  if (!outcome.ok) {
    throw new Error(outcome.error.message);
  }
  return {
    sessionId: outcome.value.handle.sessionId,
    handle: outcome.value.handle,
  };
}

export async function runRoleDetached(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  role: GsdRole,
  task: string,
  options?: { completion?: SubagentCompletion; name?: string },
): Promise<DetachedRoleRunResult> {
  const started = await startRole(pi, ctx, role, task, options);
  return {
    sessionId: started.sessionId,
    waitForResult: () => awaitRoleResult(role, started.handle),
  };
}

export async function spawnStructuredRole(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  role: GsdRole,
  task: string,
  schema: TSchemaBase,
  retryCount = 2,
): Promise<unknown> {
  const sharedSdk = createSdk(pi, ctx);
  const structured = await spawnStructuredRoleInternal(
    pi,
    sharedSdk,
    ctx,
    role,
    task,
    schema,
    retryCount,
  );
  if (!matchesSchema(schema, structured)) {
    throw new Error("Structured output does not match requested schema");
  }
  return structured;
}

export function spawnPlanner(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  task: string,
): Promise<PlanOutput> {
  return spawnStructuredRole(pi, ctx, "planner", task, PlanOutputSchema, 2).then((structured) => {
    if (!matchesPlanOutput(structured)) {
      throw new Error("Planner structured output does not match schema");
    }
    return structured;
  });
}
