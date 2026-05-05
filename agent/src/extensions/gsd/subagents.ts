import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { createSubagentSDK, TmuxAdapter, buildLaunchCommand } from "../../subagent-sdk/index.js";
import { registerBuiltInGsdModes } from "./modes.js";
import type { GsdRole } from "./roles.js";
import { resolveRoleModeName } from "./roles.js";
import type { SubagentCompletion, TSchemaBase } from "../../subagent-sdk/types.js";

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

export type SpawnRoleResult = {
  sessionId: string;
  summary: string | undefined;
  capturedOutput: string | undefined;
};

let spawnSdkFactory: SpawnSdkFactory = (pi) =>
  createSubagentSDK(pi, {
    adapter: new TmuxAdapter(
      (command, args, execOptions) => pi.exec(command, args, execOptions),
      process.cwd(),
    ),
    buildLaunchCommand,
  });

function createSdk(pi: ExtensionAPI) {
  return spawnSdkFactory(pi);
}

function matchesSchema<TSchema extends TSchemaBase>(schema: TSchema, value: unknown): boolean {
  return Value.Check(schema, value);
}

export function setGsdSubagentSdkFactoryForTests(factory: SpawnSdkFactory | undefined): void {
  spawnSdkFactory =
    factory ??
    ((pi) =>
      createSubagentSDK(pi, {
        adapter: new TmuxAdapter(
          (command, args, execOptions) => pi.exec(command, args, execOptions),
          process.cwd(),
        ),
        buildLaunchCommand,
      }));
}

async function spawnStructuredRoleInternal<TSchema extends TSchemaBase>(
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
  options?: { completion?: SubagentCompletion },
): Promise<SpawnRoleResult> {
  const sdk = createSdk(pi);
  registerBuiltInGsdModes();
  const outcome = await sdk.spawn(
    {
      name: `gsd-${role}`,
      task,
      mode: resolveRoleModeName(role),
      completion: options?.completion,
    },
    ctx,
  );
  if (!outcome.ok) {
    throw new Error(outcome.error.message);
  }
  const terminalState = await outcome.value.handle.waitForCompletion();
  let capturedOutput: string | undefined;

  try {
    const captured = await outcome.value.handle.captureOutput(80);
    const normalized = captured.text.trim();
    capturedOutput = normalized.length > 0 ? normalized : undefined;
  } catch {}

  return {
    sessionId: terminalState.sessionId,
    summary: terminalState.summary,
    capturedOutput,
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
  const sdk = createSdk(pi);
  const structured = await spawnStructuredRoleInternal(sdk, ctx, role, task, schema, retryCount);
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
