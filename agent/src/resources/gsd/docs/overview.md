# Built-in GSD For Our Agent

## Goal

Ship GSD as first-class built-in extension inside our agent.

Not wrapper around external `pi-gsd`.
Not runtime dependency on `pi-gsd-tools`.
Native implementation in this repo.

Primary success case:

- user opens repo that already has valid `.planning/`
- enables GSD
- continues milestone/phase work end-to-end with built-in commands and delegated workers
- state survives session resets
- no external package install needed

## Product Direction

- Built-in, bundled feature
- Disabled by default
- User enables with `/gsd on` or `/gsd` settings UI
- Bundled prompts, guides, role definitions, orchestration templates, docs
- Internal TypeScript implementation only
- No WXP
- No project-local `.pi/gsd` canonical workflow copies
- Compatibility promise for v1: `.planning` data only

## Source Strategy

Use:

- `pi-gsd` for Pi-specific UX ideas
- upstream GSD for workflow evolution and `.planning` conventions

Do not promise:

- exact `pi-gsd` runtime behavior
- WXP file compatibility
- `pi-gsd-tools` CLI compatibility
- `gsd-*` command-name compatibility

## UX Contract

### Enablement

- `/gsd on`
- `/gsd off`
- `/gsd` opens settings/help/overview UI
- GSD extension must be togglable

### Command Style

Primary UX:

- `/gsd new-project`
- `/gsd map-codebase`
- `/gsd discuss-phase`
- `/gsd plan-phase`
- `/gsd execute-phase`
- `/gsd verify-work`
- `/gsd validate-phase`
- `/gsd next`
- `/gsd progress`
- `/gsd stats`
  local instant support: default summary plus `json` and `table` output only; status uses local artifact truth (`Not Started`, `In Progress`, `Executed`, `Human Needed`, `Complete`)
- `/gsd health`
- `/gsd help`

Needs:

- autocomplete
- descriptions
- argument handling in command layer

**Why `/gsd <subcommand>` instead of `/gsd-<subcommand>`**

Old `pi-gsd` and upstream GSD tools expose flat top-level commands such as `/gsd plan-phase` and `/gsd progress`. We collapse these into a single `/gsd` command group. This reduces command surface pollution, gives us one autocomplete namespace, and lets the handler dispatch subcommands internally. It also mirrors how our `/executor` and `/handoff` commands work today.

### Brownfield Behavior

- detect existing `.planning/`
- continue in place
- no explicit import/migrate step required for valid `.planning`

## MVP Scope

Must ship in v1:

- bootstrap + core phase lifecycle command surface
- delegated orchestration for planning/execution/verification flows
- delegated execution roles using our subagent SDK
- instant commands: next, health, stats
- workflow-launch review command: progress
- persistent `.planning` state handling
- built-in docs
- reliable use on existing repos with `.planning`

Release blockers:

- core lifecycle commands work end-to-end
- delegated roles work reliably
- `.planning` survives resets
- user can continue existing project state
- docs shipped

## Non-Goals For v1

- exact `pi-gsd` parity
- WXP compatibility
- project-local workflow copies as canonical source
- external runtime CLI dependency
- compatibility with prior `pi-gsd-tools` shell commands
- compatibility promise beyond `.planning` data

## Architecture

### 1. GSD Extension

New bundled extension family under `src/extensions/gsd/`.

Responsibilities:

- enable/disable state
- register `/gsd` command group
- register lifecycle commands
- register instant commands
- inject GSD-specific modes/worker/subagent roles
- orchestrate subagents
- manage `.planning` detection and state helpers

### 2. Command-Orchestrated Runtime

Core workflows implemented as TypeScript command handlers.

Pattern:

- command handler parses args
- loads bundled markdown templates/resources as prompt material
- fills placeholders at runtime
- sends prepared context into agent/subagents
- updates `.planning` via internal TS modules

Use markdown as:

- role prompt templates
- orchestration templates
- docs/reference material

Do not use markdown as executable WXP programs.

### 3. Internal Backend Modules

New internal modules own:

- `.planning` read/write/validation
- roadmap/phase/todo/state parsing
- project detection
- progress/stats/health logic
- phase execution bookkeeping
- compatibility mapping for upstream-style data shapes

Implementation style:

- TypeScript
- TypeBox schemas for boundary data
- no external CLI shelling for core logic

### 4. Subagent Model

Must use our subagent SDK.

Design:

- internal role registry
- maps GSD roles to generic subagent modes under hood
- user does not need direct `gsd-executor` public mode names unless useful for debug/docs
- GSD extension may extend/improve subagent SDK if needed

Initial internal roles:

- planner
- phase-researcher
- project-researcher
- roadmapper
- executor
- verifier
- plan-checker
- debugger
- codebase-mapper

### 5. Modes Strategy

GSD defines built-in internal modes.
Role model selection should flow through our mode system.

Meaning:

- role behavior lives in bundled mode definitions/prompt resources
- mode config becomes model/persona/tooling contract for each worker class

### 6. Resources

Canonical source stays bundled in repo.

Likely structure:

- `src/resources/gsd/agents/...`
- `src/resources/modes/gsd/...`
- `src/resources/gsd/docs/...` or bundled docs path
- optional `src/resources/gsd/templates/...` if useful

No project-local `.pi/gsd` sync model in v1.

---

## Proposed File Layout

```
src/extensions/gsd/
  index.ts              -- extension factory, event wiring, toggle state
  commands.ts           -- /gsd command group registration and dispatch
  autocomplete.ts       -- subcommand autocomplete helpers
  settings.ts           -- enable/disable settings and defaults
  state/
    schema.ts           -- TypeBox schemas for .planning boundary data
    detect.ts           -- brownfield detection and validation
    read.ts             -- STATE.md, ROADMAP.md, PLAN.md parsers
    write.ts            -- atomic writes, frontmatter sync
    health.ts           -- health/check logic over .planning tree
    progress.ts         -- progress/stats/next computations
  roles.ts              -- internal role-to-mode registry
  subagents.ts          -- subagent launch wrappers per role
  instant/
    next.ts             -- /gsd next handler
    health.ts           -- /gsd health handler
    stats.ts            -- /gsd stats handler
  lifecycle/
    new-project.ts      -- /gsd new-project handler
    map-codebase.ts     -- /gsd map-codebase handler
    discuss-phase.ts    -- /gsd discuss-phase handler
    plan-phase.ts       -- /gsd plan-phase handler
    execute-phase.ts    -- /gsd execute-phase handler
    progress.ts         -- /gsd progress workflow-launch handler
    verify-work.ts      -- /gsd verify-work handler
    validate-phase.ts   -- /gsd validate-phase handler

test/
  gsd/
    fixtures/
      .planning/
        STATE.md
        ROADMAP.md
        config.json
        phases/
          01-init/
            01-01-PLAN.md
            01-01-SUMMARY.md
    schema.test.ts
    detect.test.ts
    progress.test.ts
    brownfield.test.ts
    commands.test.ts

src/resources/
  prompts/gsd/
    planner.md
    executor.md
    verifier.md
    roadmapper.md
  modes/gsd/
    planner.md
    executor.md
    verifier.md
  docs/gsd/
    user-guide.md
    command-reference.md
```

**v1 required:** `index.ts`, `commands.ts`, `autocomplete.ts`, `settings.ts`, `state/schema.ts`, `state/detect.ts`, `state/read.ts`, `state/write.ts`, `state/progress.ts`, `roles.ts`, `subagents.ts`, `instant/*.ts`, `lifecycle/*.ts`, plus bundled resources.

**Later / optional:** `state/health.ts` deep diagnostics, additional lifecycle refinements, extra fixture trees.

---

## Extension Wiring Examples

### `src/extensions/gsd/index.ts`

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerGsdCommands } from "./commands.js";
import { getGsdSettings } from "./settings.js";
import { detectExistingPlanning } from "./state/detect.js";

export default function gsdExtension(pi: ExtensionAPI): void {
  const settings = getGsdSettings();

  pi.on("session_start", async (_event, ctx) => {
    if (!settings.enabled) {
      return;
    }

    const existing = detectExistingPlanning(ctx.cwd);
    if (existing.valid) {
      ctx.ui.notify(`GSD: continuing project "${existing.projectName ?? "unknown"}"`, "info");
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!settings.enabled) {
      return event;
    }

    const planningContext = await buildGsdSystemContext(ctx.cwd);
    if (planningContext.length === 0) {
      return event;
    }

    return {
      systemPrompt: `${event.systemPrompt}\n\n${planningContext}`,
    };
  });

  registerGsdCommands(pi);
}
```

**Notes**

- Extension is registered in `src/extensions/definitions-group-*.ts` like any other bundled extension.
- Toggle state lives in `settings.ts`; disabled extension still loads but command handlers return early.
- No dynamic imports.

---

## Command Dispatch Examples

### `src/extensions/gsd/commands.ts`

```typescript
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { fuzzyFilter } from "@mariozechner/pi-tui";
import { getGsdSettings } from "./settings.js";
import { handleGsdProgress } from "./lifecycle/progress.js";
import { handleGsdNext } from "./instant/next.js";
import { handleGsdHealth } from "./instant/health.js";
import { handleGsdStats } from "./instant/stats.js";
import { handleGsdNewProject } from "./lifecycle/new-project.js";
import { handleGsdMapCodebase } from "./lifecycle/map-codebase.js";
import { handleGsdPlanPhase } from "./lifecycle/plan-phase.js";
import { handleGsdExecutePhase } from "./lifecycle/execute-phase.js";
import { handleGsdVerifyWork } from "./lifecycle/verify-work.js";
import { handleGsdValidatePhase } from "./lifecycle/validate-phase.js";
import { handleGsdDiscussPhase } from "./lifecycle/discuss-phase.js";
import { showGsdHelp } from "./help.js";
import { saveGsdSettings } from "./settings.js";

type GsdSubcommand =
  | "new-project"
  | "map-codebase"
  | "discuss-phase"
  | "plan-phase"
  | "execute-phase"
  | "verify-work"
  | "validate-phase"
  | "next"
  | "progress"
  | "stats"
  | "health"
  | "help"
  | "on"
  | "off";

const GSD_SUBCOMMANDS: Array<{ value: GsdSubcommand; description: string }> = [
  { value: "new-project", description: "Bootstrap a new GSD project" },
  { value: "map-codebase", description: "Map codebase structure into planning context" },
  { value: "discuss-phase", description: "Discuss the current phase before planning" },
  { value: "plan-phase", description: "Generate plans for the current phase" },
  { value: "execute-phase", description: "Execute the current phase with delegated workers" },
  { value: "verify-work", description: "Verify completed work against acceptance criteria" },
  { value: "validate-phase", description: "Validate phase completion and update state" },
  { value: "next", description: "Advance to the next plan or phase" },
  { value: "progress", description: "Show current milestone and phase progress" },
  { value: "stats", description: "Show project statistics" },
  { value: "health", description: "Run health checks on .planning state" },
  { value: "help", description: "Show GSD command reference" },
  { value: "on", description: "Enable GSD for this workspace" },
  { value: "off", description: "Disable GSD for this workspace" },
];

function getGsdArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  const normalized = prefix.replace(/^\s+/, "");
  const tokens = normalized.split(/\s+/).filter(Boolean);

  if (tokens.length > 1) {
    return null;
  }

  const query = tokens[0] ?? "";
  const items = GSD_SUBCOMMANDS.map((s) => ({
    value: s.value,
    label: s.value,
    description: s.description,
  }));

  if (!query) {
    return items;
  }

  const filtered = fuzzyFilter(items, query, (item) =>
    `${item.label} ${item.description ?? ""}`.toLowerCase(),
  );
  return filtered.length > 0 ? filtered : null;
}

function parseSubcommand(args: string): GsdSubcommand | undefined {
  const token = args.trim().split(/\s+/).filter(Boolean)[0];
  if (!token) {
    return undefined;
  }

  const known = GSD_SUBCOMMANDS.map((s) => s.value);
  return known.includes(token as GsdSubcommand) ? (token as GsdSubcommand) : undefined;
}

export function registerGsdCommands(pi: ExtensionAPI): void {
  pi.registerCommand("gsd", {
    description:
      "Get Shit Done: /gsd [new-project|map-codebase|plan-phase|execute-phase|progress|next|stats|health|on|off|help]",
    getArgumentCompletions: (prefix) => getGsdArgumentCompletions(prefix),
    handler: async (args, ctx) => {
      const settings = getGsdSettings();
      const subcommand = parseSubcommand(args);

      if (subcommand === "on") {
        settings.enabled = true;
        await saveGsdSettings(settings);
        ctx.ui.notify("GSD enabled", "info");
        return;
      }

      if (subcommand === "off") {
        settings.enabled = false;
        await saveGsdSettings(settings);
        ctx.ui.notify("GSD disabled", "info");
        return;
      }

      if (!settings.enabled && subcommand !== "help") {
        ctx.ui.notify("GSD is disabled. Run /gsd on to enable.", "warning");
        return;
      }

      switch (subcommand) {
        case "progress":
          await handleGsdProgress(pi, ctx);
          return;
        case "next":
          await handleGsdNext(pi, ctx);
          return;
        case "health":
          await handleGsdHealth(pi, ctx);
          return;
        case "stats":
          await handleGsdStats(pi, ctx);
          return;
        case "new-project":
          await handleGsdNewProject(pi, ctx);
          return;
        case "map-codebase":
          await handleGsdMapCodebase(pi, ctx);
          return;
        case "plan-phase":
          await handleGsdPlanPhase(pi, ctx);
          return;
        case "execute-phase":
          await handleGsdExecutePhase(pi, ctx);
          return;
        case "verify-work":
          await handleGsdVerifyWork(pi, ctx);
          return;
        case "validate-phase":
          await handleGsdValidatePhase(pi, ctx);
          return;
        case "discuss-phase":
          await handleGsdDiscussPhase(pi, ctx);
          return;
        default:
          await showGsdHelp(ctx);
          return;
      }
    },
  });
}
```

---

## .planning Schema Examples

### `src/extensions/gsd/state/schema.ts`

We use TypeBox for all boundary data that crosses the `.planning` persistence layer. The schemas below are derived from upstream GSD conventions (`~/.cache/checkouts/github.com/gsd build/get-shit-done/sdk/src/query/config-schema.ts`) and the `pi-gsd` Zod schemas (`~/.cache/checkouts/github.com/fulgidus/pi-gsd/src/lib/schemas.ts`), rewritten as TypeBox.

```typescript
import { Type, type Static } from "typebox";

export const StateFrontmatterSchema = Type.Object(
  {
    gsd_state_version: Type.Optional(Type.Union([Type.String(), Type.Number()])),
    milestone: Type.Optional(Type.String()),
    milestone_name: Type.Optional(Type.String()),
    current_phase: Type.Optional(Type.Union([Type.String(), Type.Number()])),
    current_phase_name: Type.Optional(Type.String()),
    current_plan: Type.Optional(Type.String()),
    total_phases: Type.Optional(Type.Integer({ minimum: 0 })),
    total_plans_in_phase: Type.Optional(Type.Integer({ minimum: 0 })),
    status: Type.Optional(Type.String()),
    progress: Type.Optional(
      Type.Union([
        Type.String(),
        Type.Object(
          {
            total_phases: Type.Optional(Type.Integer({ minimum: 0 })),
            completed_phases: Type.Optional(Type.Integer({ minimum: 0 })),
            percent: Type.Optional(Type.Integer({ minimum: 0 })),
          },
          { additionalProperties: true },
        ),
      ]),
    ),
    last_activity: Type.Optional(Type.String()),
    paused_at: Type.Optional(Type.String()),
    stopped_at: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

export type StateFrontmatter = Static<typeof StateFrontmatterSchema>;

export const PlanFrontmatterSchema = Type.Object(
  {
    phase: Type.Union([Type.String(), Type.Number()]),
    plan: Type.Union([Type.String(), Type.Number()]),
    type: Type.String(),
    wave: Type.Union([Type.String(), Type.Number()]),
    depends_on: Type.Union([Type.String(), Type.Array(Type.String())]),
    files_modified: Type.Union([Type.String(), Type.Array(Type.String())]),
    autonomous: Type.Union([Type.Boolean(), Type.String()]),
    requirements: Type.Optional(Type.Array(Type.String())),
    user_setup: Type.Optional(Type.Array(Type.String())),
    must_haves: Type.Union([
      Type.String(),
      Type.Array(Type.String()),
      Type.Object(
        {
          truths: Type.Optional(Type.Array(Type.String())),
          artifacts: Type.Optional(Type.Array(Type.String())),
          key_links: Type.Optional(Type.Array(Type.String())),
        },
        { additionalProperties: true },
      ),
    ]),
  },
  { additionalProperties: true },
);

export type PlanFrontmatter = Static<typeof PlanFrontmatterSchema>;

export const PlanningConfigSchema = Type.Object(
  {
    model_profile: Type.Union([
      Type.Literal("quality"),
      Type.Literal("balanced"),
      Type.Literal("budget"),
      Type.Literal("inherit"),
    ]),
    commit_docs: Type.Boolean(),
    parallelization: Type.Boolean(),
    search_gitignored: Type.Boolean(),
    brave_search: Type.Boolean(),
    firecrawl: Type.Boolean(),
    exa_search: Type.Boolean(),
    git: Type.Optional(
      Type.Object(
        {
          branching_strategy: Type.Optional(
            Type.Union([
              Type.Literal("none"),
              Type.Literal("phase"),
              Type.Literal("milestone"),
              Type.Literal("workstream"),
            ]),
          ),
          phase_branch_template: Type.Optional(Type.String()),
          milestone_branch_template: Type.Optional(Type.String()),
          quick_branch_template: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        },
        { additionalProperties: true },
      ),
    ),
    workflow: Type.Optional(
      Type.Object(
        {
          research: Type.Optional(Type.Boolean()),
          plan_check: Type.Optional(Type.Boolean()),
          verifier: Type.Optional(Type.Boolean()),
          nyquist_validation: Type.Optional(Type.Boolean()),
          auto_advance: Type.Optional(Type.Boolean()),
          node_repair: Type.Optional(Type.Boolean()),
          node_repair_budget: Type.Optional(Type.Integer({ minimum: 0 })),
          auto_retry_audit: Type.Optional(Type.Boolean()),
          auto_retry_audit_budget: Type.Optional(Type.Integer({ minimum: 0 })),
          auto_retry_tech_debt: Type.Optional(Type.Boolean()),
          auto_retry_tech_debt_budget: Type.Optional(Type.Integer({ minimum: 0 })),
          ui_phase: Type.Optional(Type.Boolean()),
          ui_safety_gate: Type.Optional(Type.Boolean()),
          text_mode: Type.Optional(Type.Boolean()),
          research_before_questions: Type.Optional(Type.Boolean()),
          discuss_mode: Type.Optional(Type.String()),
          skip_discuss: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: true },
      ),
    ),
    hooks: Type.Optional(
      Type.Object(
        {
          context_warnings: Type.Optional(Type.Boolean()),
          workflow_guard: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: true },
      ),
    ),
    agent_skills: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: true },
);

export type PlanningConfig = Static<typeof PlanningConfigSchema>;
```

### Validation with `Value.Check`

```typescript
import { Value } from "typebox/value";
import { PlanningConfigSchema, type PlanningConfig } from "./schema.js";

export function validatePlanningConfig(data: unknown): data is PlanningConfig {
  return Value.Check(PlanningConfigSchema, data);
}

export function parsePlanningConfig(data: unknown): PlanningConfig {
  if (!validatePlanningConfig(data)) {
    const errors = [...Value.Errors(PlanningConfigSchema, data)];
    const first = errors[0];
    throw new Error(
      `Invalid .planning/config.json: ${first?.message ?? "unknown error"} at ${first?.path ?? ""}`,
    );
  }
  return data;
}
```

**Why `.planning` compatibility is the promised boundary**

v1 guarantees that any repo with a valid upstream-style `.planning` directory can be opened and continued without a migration step. We do not guarantee command-name parity, runtime behavior parity, or WXP compatibility. The `.planning` directory is the durable data contract: `STATE.md`, `ROADMAP.md`, `PLAN.md`, `config.json`, and phase directories. By centering compatibility on data, we free the implementation to evolve while preserving user projects.

---

## Role Registry Examples

### `src/extensions/gsd/roles.ts`

Internal role registry maps GSD worker roles onto generic modes. The user sees `/gsd execute-phase`; under the hood the extension launches subagents using mode names that exist in our mode system.

```typescript
import type { ModeSpec } from "../../mode-utils.js";

export type GsdRole =
  | "planner"
  | "phase-researcher"
  | "project-researcher"
  | "roadmapper"
  | "executor"
  | "verifier"
  | "plan-checker"
  | "debugger"
  | "codebase-mapper";

export type GsdRoleConfig = {
  modeName: string;
  bundledPromptPath: string;
  defaultSpec: ModeSpec;
};

const ROLE_REGISTRY: Record<GsdRole, GsdRoleConfig> = {
  planner: {
    modeName: "gsd-planner",
    bundledPromptPath: "src/resources/gsd/agents/planner.md",
    defaultSpec: {
      description: "GSD planner: breaks phases into plans with acceptance criteria",
      thinkingLevel: "high",
      autoExit: true,
      autoExitTimeoutMs: 300_000,
    },
  },
  executor: {
    modeName: "gsd-executor",
    bundledPromptPath: "src/resources/gsd/agents/executor.md",
    defaultSpec: {
      description: "GSD executor: implements plans and produces SUMMARY.md",
      thinkingLevel: "medium",
      autoExit: true,
      autoExitTimeoutMs: 600_000,
    },
  },
  verifier: {
    modeName: "gsd-verifier",
    bundledPromptPath: "src/resources/gsd/agents/verifier.md",
    defaultSpec: {
      description: "GSD verifier: checks deliverables against must-haves",
      thinkingLevel: "medium",
      autoExit: true,
      autoExitTimeoutMs: 300_000,
    },
  },
  "codebase-mapper": {
    modeName: "gsd-codebase-mapper",
    bundledPromptPath: "src/resources/gsd/agents/codebase-mapper.md",
    defaultSpec: {
      description: "GSD codebase mapper: produces structural context for planning",
      thinkingLevel: "medium",
      autoExit: true,
      autoExitTimeoutMs: 300_000,
    },
  },
  // remaining roles follow same pattern
  "phase-researcher": {
    modeName: "gsd-phase-researcher",
    bundledPromptPath: "src/resources/gsd/agents/phase-researcher.md",
    defaultSpec: { description: "GSD phase researcher", thinkingLevel: "medium", autoExit: true },
  },
  "project-researcher": {
    modeName: "gsd-project-researcher",
    bundledPromptPath: "src/resources/gsd/agents/project-researcher.md",
    defaultSpec: { description: "GSD project researcher", thinkingLevel: "medium", autoExit: true },
  },
  roadmapper: {
    modeName: "gsd-roadmapper",
    bundledPromptPath: "src/resources/gsd/agents/roadmapper.md",
    defaultSpec: { description: "GSD roadmapper", thinkingLevel: "high", autoExit: true },
  },
  "plan-checker": {
    modeName: "gsd-plan-checker",
    bundledPromptPath: "src/resources/gsd/agents/plan-checker.md",
    defaultSpec: { description: "GSD plan checker", thinkingLevel: "medium", autoExit: true },
  },
  debugger: {
    modeName: "gsd-debugger",
    bundledPromptPath: "src/resources/gsd/agents/debugger.md",
    defaultSpec: { description: "GSD debugger", thinkingLevel: "medium", autoExit: true },
  },
};

export function resolveRoleModeName(role: GsdRole): string {
  return ROLE_REGISTRY[role].modeName;
}

export function resolveRolePromptPath(role: GsdRole): string {
  return ROLE_REGISTRY[role].bundledPromptPath;
}

export function resolveRoleDefaultSpec(role: GsdRole): ModeSpec {
  return ROLE_REGISTRY[role].defaultSpec;
}
```

**How built-in internal modes drive model selection for GSD workers**

Each role entry maps to a mode name (e.g., `gsd-planner`). The extension injects bundled mode definitions into the mode system at session start, or relies on the user having them in their global/project modes file. The mode spec carries `provider`, `modelId`, `thinkingLevel`, and `tools`. Subagent launches pass the mode name via the `mode` field of the subagent start params, so the child session runs with the correct model and prompt configuration without the GSD extension manually selecting models.

---

## Subagent Orchestration Examples

### `src/extensions/gsd/subagents.ts`

```typescript
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { SubagentSDK } from "../../subagent-sdk/sdk-types.js";
import { createSubagentSDK } from "../../subagent-sdk/sdk.js";
import { TmuxAdapter } from "../../subagent-sdk/tmux.js";
import { buildLaunchCommand } from "../../subagent-sdk/launch.js";
import type { GsdRole } from "./roles.js";
import { resolveRoleModeName } from "./roles.js";
import { loadBundledPrompt } from "./resources.js";

const PlanOutputSchema = Type.Object(
  {
    plans: Type.Array(
      Type.Object({
        plan: Type.String(),
        phase: Type.String(),
        type: Type.String(),
        wave: Type.Union([Type.String(), Type.Number()]),
        depends_on: Type.Array(Type.String()),
        files_modified: Type.Array(Type.String()),
        autonomous: Type.Boolean(),
        must_haves: Type.Array(Type.String()),
      }),
    ),
  },
  { additionalProperties: false },
);

export type PlanOutput = Static<typeof PlanOutputSchema>;

export function createGsdSubagentSDK(pi: ExtensionAPI): SubagentSDK {
  const adapter = new TmuxAdapter(
    (command, args, execOptions) => pi.exec(command, args, execOptions),
    process.cwd(),
  );
  return createSubagentSDK(pi, { adapter, buildLaunchCommand });
}

export async function spawnPlanner(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  phaseContext: string,
): Promise<PlanOutput> {
  const sdk = createGsdSubagentSDK(pi);
  const prompt = await loadBundledPrompt("planner");
  const task = `${prompt}\n\nPhase context:\n${phaseContext}`;

  const outcome = await sdk.spawn(
    {
      action: "start",
      name: "gsd-planner",
      task,
      mode: resolveRoleModeName("planner"),
      outputFormat: {
        type: "json_schema",
        schema: PlanOutputSchema,
        retryCount: 3,
      },
    },
    ctx,
  );

  if (outcome.ok && outcome.value.structured !== undefined) {
    return outcome.value.structured as PlanOutput;
  }

  throw new Error(outcome.ok ? "Planner returned no structured output" : outcome.error.message);
}

export async function spawnExecutor(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  planContext: string,
): Promise<void> {
  const sdk = createGsdSubagentSDK(pi);
  const prompt = await loadBundledPrompt("executor");
  const task = `${prompt}\n\nPlan context:\n${planContext}`;

  const outcome = await sdk.spawn(
    {
      action: "start",
      name: "gsd-executor",
      task,
      mode: resolveRoleModeName("executor"),
    },
    ctx,
  );

  if (!outcome.ok) {
    throw new Error(`Executor failed: ${outcome.error.message}`);
  }

  await outcome.value.handle.waitForCompletion();
}
```

**Why subagent SDK is a hard dependency for full GSD mode**

Delegated worker roles are not optional cosmetics; they are the core execution model for `/gsd plan-phase` and `/gsd execute-phase`. Without the subagent SDK, the extension would have to inline all planning and execution in the parent session, defeating the purpose of multi-agent orchestration and blowing context windows. The subagent SDK provides structured output, pane management, lifecycle events, and mode inheritance. GSD v1 depends on all of these.

---

## Brownfield Detection Examples

### `src/extensions/gsd/state/detect.ts`

```typescript
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Value } from "typebox/value";
import { PlanningConfigSchema } from "./schema.js";

export type BrownfieldResult =
  | { valid: true; projectName: string | undefined; phaseCount: number }
  | { valid: false; reason: string };

export function detectExistingPlanning(cwd: string): BrownfieldResult {
  const planningDir = join(cwd, ".planning");
  if (!existsSync(planningDir)) {
    return { valid: false, reason: "no .planning directory" };
  }

  const configPath = join(planningDir, "config.json");
  if (!existsSync(configPath)) {
    return { valid: false, reason: "missing config.json" };
  }

  let configData: unknown;
  try {
    configData = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return { valid: false, reason: "config.json is not valid JSON" };
  }

  if (!Value.Check(PlanningConfigSchema, configData)) {
    const first = [...Value.Errors(PlanningConfigSchema, configData)][0];
    return {
      valid: false,
      reason: `config.json schema error: ${first?.message ?? "unknown"} at ${first?.path ?? ""}`,
    };
  }

  const statePath = join(planningDir, "STATE.md");
  const roadmapPath = join(planningDir, "ROADMAP.md");
  if (!existsSync(statePath) && !existsSync(roadmapPath)) {
    return { valid: false, reason: "missing STATE.md and ROADMAP.md" };
  }

  const phasesDir = join(planningDir, "phases");
  const phaseCount = existsSync(phasesDir)
    ? readDirSafe(phasesDir).filter((d) => d.isDirectory()).length
    : 0;

  const projectName = extractProjectName(statePath);

  return { valid: true, projectName, phaseCount };
}

function readDirSafe(dir: string): Array<{ name: string; isDirectory(): boolean }> {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function extractProjectName(statePath: string): string | undefined {
  try {
    const content = readFileSync(statePath, "utf-8");
    const match = content.match(/\*\*Project:\*\*\s*(.+)/i);
    return match ? match[1].trim() : undefined;
  } catch {
    return undefined;
  }
}
```

**How existing repos with valid `.planning` are detected and continued in place**

On `session_start`, the extension calls `detectExistingPlanning(cwd)`. If the result is `valid`, it skips any bootstrap scaffolding and treats the current `.planning` tree as the source of truth. Lifecycle commands such as `/gsd progress` now launch bundled local review workflows over that existing `.planning` tree instead of ad-hoc notify output. `/gsd next` now runs a local pre-routing safety pass before dispatch: paused `STATE.md`, blocking `.planning/.continue-here.md`, active discuss checkpoints, and unresolved verification FAIL artifacts stop routing with a diagnostic instead of silently advancing. When next phase prep is still missing, `/gsd next` may route through `/gsd discuss-phase` before `/gsd plan-phase`. It only routes to `/gsd complete-milestone` after milestone phases have authoritative local `*-UAT.md` artifacts in `status: complete`; legacy `*-VERIFICATION.md` evidence alone still routes through `/gsd verify-work`. If workflow-session launch support is unavailable, `/gsd next` fails closed with warning instead of mutating `STATE.md` pointers locally. No import dialog, no migration copy, no rewrite of file paths.

---

## Instant Command Examples

### Deterministic output contracts

Only local instant commands should return predictable shapes so UI layers and test assertions can rely on them. Workflow-launched commands like `/gsd progress` are not part of this deterministic instant-output contract.

```typescript
// src/extensions/gsd/instant/next.ts
import { Type, type Static } from "typebox";

export const NextOutputSchema = Type.Object(
  {
    advanced: Type.Boolean(),
    previousPlan: Type.Optional(Type.Integer()),
    currentPlan: Type.Optional(Type.Integer()),
    totalPlans: Type.Optional(Type.Integer()),
    reason: Type.String(),
    newPhase: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type NextOutput = Static<typeof NextOutputSchema>;
```

```typescript
// src/extensions/gsd/instant/health.ts
import { Type, type Static } from "typebox";

export const HealthOutputSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("healthy"), Type.Literal("degraded"), Type.Literal("broken")]),
    healthy: Type.Boolean(),
    repairableCount: Type.Number(),
    repairsPerformed: Type.Optional(
      Type.Array(
        Type.Object({
          action: Type.String(),
          success: Type.Boolean(),
        }),
      ),
    ),
    issues: Type.Array(
      Type.Object({
        severity: Type.Union([
          Type.Literal("error"),
          Type.Literal("warning"),
          Type.Literal("info"),
        ]),
        code: Type.String(),
        message: Type.String(),
      }),
    ),
  },
  { additionalProperties: false },
);

export type HealthOutput = Static<typeof HealthOutputSchema>;
```

```typescript
// src/extensions/gsd/instant/stats.ts
import { Type, type Static } from "typebox";

export const StatsOutputSchema = Type.Object(
  {
    phaseCount: Type.Integer({ minimum: 0 }),
    planCount: Type.Integer({ minimum: 0 }),
    summaryCount: Type.Integer({ minimum: 0 }),
    verificationCount: Type.Integer({ minimum: 0 }),
    openBlockers: Type.Integer({ minimum: 0 }),
    decisionsCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type StatsOutput = Static<typeof StatsOutputSchema>;
```

---

## Resource Loading Examples

### `src/extensions/gsd/resources.ts`

Bundled resources are discovered via the existing `bundled-resources.ts` patch. GSD-specific agent prompts and modes live under `src/resources/gsd/agents/` and `src/resources/modes/gsd/`.

```typescript
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GsdRole } from "./roles.js";
import { resolveRolePromptPath } from "./roles.js";

const extensionDir = import.meta.dirname;

export function loadBundledPrompt(role: GsdRole): string {
  const relativePath = resolveRolePromptPath(role);
  const absolutePath = join(extensionDir, "..", "..", "..", relativePath);
  return readFileSync(absolutePath, "utf-8");
}

export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => vars[key] ?? "");
}
```

Example bundled prompt (`src/resources/gsd/agents/executor.md`):

```markdown
# GSD Executor

You are an execution agent. Your job is to implement the provided plan,
produce the required files, and write a SUMMARY.md in the same phase directory.

Rules:

- Do not change files outside the plan's `files_modified` list.
- Verify each `must_haves` item before declaring completion.
- If blocked, record the blocker in STATE.md and exit.
```

---

## Testing Examples

### Fixture layout

```
test/gsd/fixtures/
  greenfield/
    .planning/
      config.json
      STATE.md
      ROADMAP.md
  brownfield-v1/
    .planning/
      config.json
      STATE.md
      ROADMAP.md
      phases/
        01-setup/
          01-01-PLAN.md
          01-01-SUMMARY.md
        02-core/
          02-01-PLAN.md
```

### Schema validation test

```typescript
// test/gsd/schema.test.ts
import { describe, it, expect } from "vitest";
import { Value } from "typebox/value";
import {
  PlanningConfigSchema,
  PlanFrontmatterSchema,
} from "../../src/extensions/gsd/state/schema.js";

describe("PlanningConfigSchema", () => {
  it("accepts minimal valid config", () => {
    const data = {
      model_profile: "balanced",
      commit_docs: true,
      parallelization: true,
      search_gitignored: false,
      brave_search: false,
      firecrawl: false,
      exa_search: false,
    };
    expect(Value.Check(PlanningConfigSchema, data)).toBe(true);
  });

  it("rejects missing required field", () => {
    const data = { model_profile: "balanced" };
    expect(Value.Check(PlanningConfigSchema, data)).toBe(false);
  });
});

describe("PlanFrontmatterSchema", () => {
  it("accepts pi-gsd style plan frontmatter", () => {
    const data = {
      phase: "01",
      plan: "01",
      type: "implementation",
      wave: 1,
      depends_on: [],
      files_modified: ["src/index.ts"],
      autonomous: true,
      must_haves: ["feature works", "tests pass"],
    };
    expect(Value.Check(PlanFrontmatterSchema, data)).toBe(true);
  });
});
```

### Brownfield continuation test

```typescript
// test/gsd/brownfield.test.ts
import { describe, it, expect } from "vitest";
import { detectExistingPlanning } from "../../src/extensions/gsd/state/detect.js";
import { join } from "node:path";

const fixtures = join(__dirname, "fixtures");

describe("detectExistingPlanning", () => {
  it("detects valid brownfield project", () => {
    const result = detectExistingPlanning(join(fixtures, "brownfield-v1"));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.phaseCount).toBe(2);
    }
  });

  it("rejects missing .planning", () => {
    const result = detectExistingPlanning(join(fixtures, "greenfield"));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("no .planning");
    }
  });
});
```

### Subagent orchestration test

```typescript
// test/gsd/subagents.test.ts
import { describe, it, expect, vi } from "vitest";
import { spawnPlanner } from "../../src/extensions/gsd/subagents.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

describe("spawnPlanner", () => {
  it("returns parsed plan output on success", async () => {
    const mockSdk = {
      spawn: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          structured: {
            plans: [
              {
                plan: "01",
                phase: "01",
                type: "implementation",
                wave: 1,
                depends_on: [],
                files_modified: ["a.ts"],
                autonomous: true,
                must_haves: ["works"],
              },
            ],
          },
        },
      }),
    };

    const pi = {} as unknown as ExtensionAPI;
    const ctx = {} as unknown as ExtensionCommandContext;

    // Inject mock SDK via module-level override or factory param in real tests
    const result = await spawnPlanner(pi, ctx, "Phase 1: bootstrap");
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].plan).toBe("01");
  });
});
```

---

## Decision Notes

### Locked decisions preserved

- Built-in, bundled, disabled by default
- `/gsd <subcommand>` UX
- TS command orchestration, markdown as template/resource
- No WXP
- No external CLI backend
- Use subagent SDK
- Internal role registry over generic modes
- `.planning` compatibility only
- Brownfield detect-and-continue
- Docs ship in v1

### Why `/gsd <subcommand>` differs from old `/gsd-*`

The old `pi-gsd` extension registered many top-level slash commands (`/gsd plan-phase`, `/gsd progress`, etc.). This pollutes the global command namespace and complicates autocomplete. By registering a single `/gsd` command group with internal subcommand dispatch, we:

1. Reserve one command slot.
2. Provide a single autocomplete surface.
3. Match the pattern used by `/executor`, `/handoff`, and `/mode` in this repo.
4. Make it easier to gate the entire feature behind the enable/disable toggle.

### Why `.planning` compatibility is the promised boundary

User repos with `.planning` directories represent real work. Breaking their data format would force migrations and erode trust. By promising data compatibility only, we allow ourselves to rewrite the runtime entirely while keeping user projects loadable. This is the same contract used by upstream GSD between CLI versions.

### How built-in internal modes drive model selection for GSD workers

The role registry does not hardcode model IDs. It maps roles to mode names. The mode system (already present in this repo) resolves mode names to `provider/modelId`, `thinkingLevel`, and `tools`. When a subagent is spawned with `mode: "gsd-planner"`, the child session inherits that mode's model selection and system prompt. This means:

- Power users can override GSD worker models via their global modes file.
- The GSD extension does not need its own model picker.
- Subagent SDK handles mode inheritance automatically.

### Why subagent SDK is hard dependency for full GSD mode

See the orchestration examples above. Planning and execution require child sessions with structured output, mode inheritance, and lifecycle management. Reimplementing this inside the GSD extension would duplicate the subagent SDK and create maintenance debt. The subagent SDK is already bundled and tested.

### How existing repos with valid `.planning` are detected and continued in place

See `detect.ts` example above. Detection is a read-only validation pass. If valid, the extension never writes to `.planning` unless the user issues a mutating command. Continue-in-place means:

- `STATE.md` frontmatter is parsed, not recreated.
- Phase directories are enumerated from disk.
- Plan/summary counts are derived from existing files.
- The user picks up exactly where they left off.

---

## Resolved Decisions

1. **Mode injection vs. user-managed modes**
   Built-in GSD auto-injects missing `gsd-*` mode definitions into the project modes file via `ensureBuiltInGsdModes()`, while preserving any existing user overrides.

2. **Phase directory naming conventions**
   Brownfield detection accepts integer and dotted phase numbers. Writes normalize to `{phase-number}-{slug}` directory names, so `2.1-hotfix/` remains valid.

3. **Structured output retry budget defaults**
   Built-in GSD uses a uniform retry budget of `2` for structured-output worker calls. This keeps orchestration deterministic and is what current tests cover.

4. **Enablement persistence scope**
   `/gsd on` and `/gsd off` persist per workspace in `.pi/gsd.json`.

5. **ROADMAP.md parsing strategy**
   Built-in GSD parses structured `ROADMAP.md` headings and plan lists directly, while falling back to phase directories when roadmap structure is incomplete.

6. **Testing strategy for lifecycle commands**
   Built-in GSD uses mocked subagent SDK tests for orchestration and lifecycle handlers, plus brownfield fixture coverage for `.planning` compatibility.

7. **Resource bundling for mode definitions**
   Mode definitions are synthesized from bundled agents at runtime; there is no separate `src/resources/modes/gsd/` source tree in v1.

## Remaining Non-Blocking Questions

1. **Subagent SDK gaps for orchestration scale**
   Parallel executor throttling beyond current bounded orchestration remains future work. This is outside the current `.planning` compatibility boundary and is not relied on by the shipped tests.

---

## Data Compatibility Boundary

v1 must preserve compatibility for `.planning` data, including:

- milestones
- phases
- plans
- todos
- goals
- tasks
- status/progress state

Meaning:

- built-in GSD can adopt existing valid `.planning`
- built-in GSD reads/writes compatible shapes
- migration story centered on data continuity, not command/runtime parity

## Required Command Surface

### Lifecycle

- `/gsd new-project`
- `/gsd map-codebase`
- `/gsd discuss-phase`
- `/gsd plan-phase`
- `/gsd execute-phase`
- `/gsd verify-work`
- `/gsd validate-phase`

### Instant

- `/gsd next`
- `/gsd stats`
- `/gsd health`
- `/gsd help`

### Workflow Review

- `/gsd progress`

### Control

- `/gsd`
- `/gsd on`
- `/gsd off`

## Implementation Workstreams

### Workstream 1: Extension Shell

- GSD enable/disable state
- `/gsd` command group
- settings UI
- resource wiring
- extension toggle behavior

### Workstream 2: `.planning` Core

- schema inventory
- parser/writer modules
- compatibility tests against existing `.planning`
- health/progress/stats/next logic

### Workstream 3: Worker Role System

- internal role registry
- mode mappings
- subagent SDK integration points
- worker launch contract
- role prompt resources

### Workstream 4: Orchestration Commands

- `new-project`
- `map-codebase`
- `discuss-phase`
- `plan-phase`
- `execute-phase`
- `verify-work`
- `validate-phase`

### Workstream 5: Brownfield Continuation

- detect existing `.planning`
- validate/adopt current state
- continue in place
- error messaging for malformed state

### Workstream 6: Docs

- user guide
- architecture doc
- command reference
- subagent role reference
- `.planning` compatibility notes

## Testing Strategy

Need:

- unit tests for `.planning` parsing and writing
- compatibility fixtures from real `.planning` trees
- command-level tests for instant commands
- orchestration tests for lifecycle happy paths
- subagent role tests
- brownfield continuation tests
- session reset persistence tests

Key acceptance tests:

1. existing repo with `.planning` opens and GSD continues in place
2. `/gsd new-project` boots greenfield flow
3. `/gsd plan-phase` and `/gsd execute-phase` complete with delegated workers
4. `/gsd next|stats|health` deterministic; default `/gsd progress` launches workflow review
5. disable/enable toggle works cleanly

## Risk Areas

Biggest risks:

- subagent SDK gaps for GSD orchestration scale
- mapping upstream workflow concepts into native command handlers
- preserving `.planning` compatibility while simplifying runtime model
- keeping full lifecycle in MVP without WXP shortcuts

If schedule slips, cut first:

- behavioral parity with `pi-gsd` and upstream prompt details
- breadth beyond mandatory v1 commands
- migration tooling beyond "detect and continue valid `.planning`"

Do not cut:

- delegated worker reliability
- `.planning` compatibility
- end-to-end lifecycle
- instant commands
- docs

## Success Metric

30 days after launch:

- can enable built-in GSD in active repo that already has meaningful `.planning`
- continue milestones/phases without external package
- rely on built-in delegated workers and commands daily
- no fallback to manual planning workflow required

## References

use liberian skill to load those repos

- Upstream GSD: `https://github.com/gsd build/get-shit-done`
- Pi GSD port: `https://github.com/fulgidus/pi-gsd`

Upstream concepts inform workflow evolution and `.planning` conventions. `pi-gsd` informs Pi UX and command surface design. We do not promise runtime parity with either.
