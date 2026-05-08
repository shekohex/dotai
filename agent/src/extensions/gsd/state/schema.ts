import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const StateProgressSchema = Type.Object(
  {
    total_phases: Type.Optional(Type.Integer({ minimum: 0 })),
    completed_phases: Type.Optional(Type.Integer({ minimum: 0 })),
    percent: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: true },
);

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
    progress: Type.Optional(Type.Union([Type.String(), StateProgressSchema])),
    last_activity: Type.Optional(Type.String()),
    paused_at: Type.Optional(Type.String()),
    stopped_at: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

export type StateFrontmatter = Static<typeof StateFrontmatterSchema>;

const PlanMustHavesSchema = Type.Object(
  {
    truths: Type.Optional(Type.Array(Type.String())),
    artifacts: Type.Optional(Type.Array(Type.String())),
    key_links: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: true },
);

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
    must_haves: Type.Union([Type.String(), Type.Array(Type.String()), PlanMustHavesSchema]),
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
    granularity: Type.Optional(
      Type.Union([Type.Literal("coarse"), Type.Literal("standard"), Type.Literal("fine")]),
    ),
    commit_docs: Type.Boolean(),
    parallelization: Type.Boolean(),
    search_gitignored: Type.Boolean(),
    brave_search: Type.Boolean(),
    firecrawl: Type.Boolean(),
    exa_search: Type.Boolean(),
    context_window: Type.Optional(Type.Integer({ minimum: 1 })),
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
          tdd_mode: Type.Optional(Type.Boolean()),
          discuss_mode: Type.Optional(
            Type.Union([Type.Literal("discuss"), Type.Literal("assumptions")]),
          ),
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

export const DiscussDecisionSchema = Type.Object(
  {
    id: Type.String(),
    area: Type.String(),
    decision: Type.String(),
    source: Type.Union([Type.Literal("user"), Type.Literal("auto"), Type.Literal("assumption")]),
  },
  { additionalProperties: false },
);

export const DiscussReferenceSchema = Type.Object(
  {
    path: Type.String(),
    reason: Type.String(),
  },
  { additionalProperties: false },
);

export const DiscussDraftSchema = Type.Object(
  {
    phaseBoundary: Type.String(),
    implementationDecisions: Type.Array(DiscussDecisionSchema),
    discretionAreas: Type.Array(Type.String()),
    canonicalReferences: Type.Array(DiscussReferenceSchema),
    existingCodeInsights: Type.Array(Type.String()),
    specificIdeas: Type.Array(Type.String()),
    deferredIdeas: Type.Array(Type.String()),
    discussionLog: Type.Array(Type.String()),
    chainNextStep: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type DiscussDraft = Static<typeof DiscussDraftSchema>;

export const DiscussCheckpointSchema = Type.Object(
  {
    phase: Type.String(),
    mode: Type.Union([Type.Literal("discuss"), Type.Literal("assumptions")]),
    route: Type.Union([
      Type.Literal("default-discuss"),
      Type.Literal("assumptions-preview"),
      Type.Literal("assumptions-artifact"),
    ]),
    all: Type.Boolean(),
    auto: Type.Boolean(),
    chain: Type.Boolean(),
    text: Type.Boolean(),
    stage: Type.Union([
      Type.Literal("init"),
      Type.Literal("existing-context"),
      Type.Literal("gray-area-analysis"),
      Type.Literal("gray-area-selection"),
      Type.Literal("area-question"),
      Type.Literal("area-more"),
      Type.Literal("final-loop"),
      Type.Literal("done"),
    ]),
    pendingPrompt: Type.String(),
    promptOptions: Type.Array(Type.String()),
    priorContextSummary: Type.String(),
    scoutSummary: Type.String(),
    existingContextSummary: Type.Optional(Type.String()),
    grayAreaAnalysis: Type.Optional(Type.String()),
    areaQuestions: Type.Record(Type.String(), Type.Array(Type.String())),
    areaSelections: Type.Record(Type.String(), Type.Array(Type.String())),
    areasCompleted: Type.Array(Type.String()),
    areasRemaining: Type.Array(Type.String()),
    activeArea: Type.Optional(Type.String()),
    assumptionsAutoReady: Type.Boolean(),
    assumptionsResearchGaps: Type.Array(Type.String()),
    deferredIdeas: Type.Array(Type.String()),
    canonicalReferences: Type.Array(Type.String()),
    draft: DiscussDraftSchema,
  },
  { additionalProperties: false },
);

export type DiscussCheckpoint = Static<typeof DiscussCheckpointSchema>;

export const GsdSettingsSchema = Type.Object(
  {
    enabled: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type GsdSettings = Static<typeof GsdSettingsSchema>;

export function validatePlanningConfig(data: unknown): data is PlanningConfig {
  return Value.Check(PlanningConfigSchema, data);
}

export function parsePlanningConfig(data: unknown): PlanningConfig {
  if (validatePlanningConfig(data)) {
    return data;
  }
  const first = [...Value.Errors(PlanningConfigSchema, data)][0];
  throw new Error(`Invalid .planning/config.json: ${first?.message ?? "unknown error"}`);
}

export function parseGsdSettings(data: unknown): GsdSettings {
  if (Value.Check(GsdSettingsSchema, data)) {
    return data;
  }
  return { enabled: false };
}
