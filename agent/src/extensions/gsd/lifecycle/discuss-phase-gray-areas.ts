import type { DiscussCheckpoint } from "../state/schema.js";
import type { DiscussRoute } from "../state/discuss.js";

export type GrayArea = { area: string; prompt: string; questions: string[] };

export function buildDefaultGrayAreas(): GrayArea[] {
  return [
    {
      area: "Implementation approach",
      prompt: "Choose implementation approach inside phase boundary.",
      questions: [
        "What path should downstream implementation follow?",
        "What constraint matters most for this approach?",
      ],
    },
    {
      area: "Canonical references",
      prompt: "Name docs or files downstream work must honor.",
      questions: [
        "Which files or docs are mandatory references?",
        "What existing pattern should planner preserve?",
      ],
    },
    {
      area: "Risks and deferrals",
      prompt: "Capture edge cases, scope creep, and deferred work.",
      questions: [
        "What should stay out of scope for this phase?",
        "What risk needs explicit note before planning?",
      ],
    },
  ];
}

export function buildAssumptionsPreviewAreas(): GrayArea[] {
  return [
    {
      area: "Assumptions to confirm",
      prompt: "Preview assumptions and note corrections without writing artifacts.",
      questions: [
        "Which assumption looks safest?",
        "Which assumption needs correction before planning?",
      ],
    },
  ];
}

export function buildGrayAreaAnalysis(route: DiscussRoute, areas: GrayArea[]): string {
  let routeLabel = "Default discuss";
  if (route === "assumptions-preview") {
    routeLabel = "Preview assumptions only";
  } else if (route === "assumptions-artifact") {
    routeLabel = "Assumptions artifact";
  }
  return `${routeLabel}. Remaining gray areas: ${areas.map((item) => item.area).join(", ")}.`;
}

export function pickAreaQuestions(area: GrayArea): string[] {
  return [...area.questions];
}

export function grayAreasForCheckpoint(checkpoint: DiscussCheckpoint): GrayArea[] {
  return checkpoint.route === "default-discuss"
    ? buildDefaultGrayAreas()
    : buildAssumptionsPreviewAreas();
}
