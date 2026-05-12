import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { GsdCommandArgs } from "../args.js";
import { resolveGsdBundlePath } from "../resources.js";
import { resolveValidatePhaseSelection } from "../state/validate-phase.js";
import { readPlanningSnapshot } from "../state/read.js";
import { launchGsdWorkflowSession } from "../workflow-launch.js";

const AuditUatItemSchema = Type.Object(
  {
    test: Type.Optional(Type.Union([Type.Number(), Type.String()])),
    name: Type.Optional(Type.String()),
    expected: Type.Optional(Type.String()),
    why_human: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
    result: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

const AuditUatResultSchema = Type.Object(
  {
    phase: Type.Optional(Type.String()),
    file: Type.Optional(Type.String()),
    type: Type.Optional(Type.String()),
    items: Type.Array(AuditUatItemSchema),
  },
  { additionalProperties: true },
);

const AuditUatSummarySchema = Type.Object(
  {
    total_items: Type.Number(),
  },
  { additionalProperties: true },
);

const AuditUatOutputSchema = Type.Object(
  {
    results: Type.Array(AuditUatResultSchema),
    summary: AuditUatSummarySchema,
  },
  { additionalProperties: true },
);

type AuditUatOutput = Static<typeof AuditUatOutputSchema>;

function resolvePlanRequirementValue(
  planRequirements: string[] | undefined,
  phaseRequirements: string[],
): string {
  if (planRequirements !== undefined && planRequirements.length > 0) {
    return planRequirements.join(", ");
  }
  if (phaseRequirements.length > 0) {
    return phaseRequirements.join(", ");
  }
  return "Unmapped in ROADMAP.md";
}

function resolveValidationRowStatus(
  fileExists: string,
  hasAutomatedRunner: boolean,
  hasVerificationEvidence: boolean,
  hasUatEvidence: boolean,
): string {
  if (fileExists === "❌") {
    return "MISSING";
  }
  if (hasAutomatedRunner && (hasVerificationEvidence || hasUatEvidence)) {
    return "COVERED";
  }
  return "PARTIAL";
}

function buildTaskRows(
  phaseSnapshot: ReturnType<typeof readPlanningSnapshot>["phases"][number] | undefined,
  selection: NonNullable<ReturnType<typeof resolveValidatePhaseSelection>["selection"]>,
  quickRunCommand: string,
  hasAutomatedRunner: boolean,
  hasVerificationEvidence: boolean,
  hasUatEvidence: boolean,
): string {
  return selection.phase.plans
    .map((plan) => {
      const planFile = phaseSnapshot?.plans.find((entry) =>
        entry.fileName.startsWith(`${plan.id}-`),
      );
      const requirementValue = resolvePlanRequirementValue(
        planFile?.frontmatter.requirements,
        selection.phase.requirements,
      );
      const waveValue =
        planFile?.frontmatter.wave === undefined ? "-" : String(planFile.frontmatter.wave);
      const fileExists =
        phaseSnapshot?.summaries.includes(`${plan.id}-SUMMARY.md`) === true ? "✅" : "❌";
      const status = resolveValidationRowStatus(
        fileExists,
        hasAutomatedRunner,
        hasVerificationEvidence,
        hasUatEvidence,
      );
      return `| ${plan.id} | ${plan.id.split("-")[1] ?? "--"} | ${waveValue} | ${requirementValue} | — | Pending workflow audit | unknown | \`${quickRunCommand}\` | ${fileExists} | ${status} |`;
    })
    .join("\n");
}

function buildManualVerificationRows(
  auditUat: AuditUatOutput | undefined,
  selection: NonNullable<ReturnType<typeof resolveValidatePhaseSelection>["selection"]>,
): string {
  const phaseAuditEntries =
    auditUat?.results.filter((entry) => entry.phase === selection.phase.number) ?? [];
  return phaseAuditEntries
    .flatMap((entry) =>
      entry.items.map((item) => {
        const behavior = item.name ?? item.expected ?? "Unresolved manual verification";
        const requirement = selection.phase.requirements.at(0) ?? "—";
        let whyManual = item.why_human ?? item.reason ?? "Requires human follow-up";
        if (entry.type === "verification" && item.result === "human_needed") {
          whyManual = item.why_human ?? "Marked human_needed in VERIFICATION.md";
        } else if (item.result === "blocked") {
          whyManual = item.reason ?? "Blocked during UAT";
        } else if (item.result === "pending") {
          whyManual = "Pending UAT follow-up";
        }
        const instructions = item.expected ?? item.name ?? "See existing artifact for exact steps";
        return `| ${behavior.replaceAll("\n", " ")} | ${requirement} | ${whyManual.replaceAll("\n", " ")} | ${instructions.replaceAll("\n", " ")} |`;
      }),
    )
    .join("\n");
}

function stripValidatePhaseSubcommand(rawArgs: string): string | undefined {
  const normalizedRawArgs = rawArgs
    .trim()
    .replace(/^validate-phase(?:\s+|$)/u, "")
    .trim();
  return normalizedRawArgs.length > 0 ? normalizedRawArgs : undefined;
}

function normalizePhaseSlug(phaseName: string): string {
  return phaseName
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

function detectValidationFramework(cwd: string): {
  framework: string;
  configFile: string;
  quickRunCommand: string;
  fullSuiteCommand: string;
} {
  const packageJsonPath = join(cwd, "package.json");
  if (!existsSync(packageJsonPath)) {
    return {
      framework: "other",
      configFile: "not detected",
      quickRunCommand: "not detected",
      fullSuiteCommand: "not detected",
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return {
        framework: "other",
        configFile: "package.json",
        quickRunCommand: "not detected",
        fullSuiteCommand: "not detected",
      };
    }

    const pkg = parsed as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    const dependencies = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);
    const testCommand = pkg.scripts?.test === undefined ? "not detected" : "npm test";

    if (dependencies.has("vitest")) {
      let configFile = "package.json";
      if (existsSync(join(cwd, "vitest.config.ts"))) {
        configFile = "vitest.config.ts";
      } else if (existsSync(join(cwd, "vitest.config.mts"))) {
        configFile = "vitest.config.mts";
      }

      return {
        framework: "vitest",
        configFile,
        quickRunCommand: testCommand,
        fullSuiteCommand: testCommand,
      };
    }

    if (dependencies.has("jest")) {
      let configFile = "package.json";
      if (existsSync(join(cwd, "jest.config.ts"))) {
        configFile = "jest.config.ts";
      } else if (existsSync(join(cwd, "jest.config.js"))) {
        configFile = "jest.config.js";
      }

      return {
        framework: "jest",
        configFile,
        quickRunCommand: testCommand,
        fullSuiteCommand: testCommand,
      };
    }

    return {
      framework: "other",
      configFile: "package.json",
      quickRunCommand: testCommand,
      fullSuiteCommand: testCommand,
    };
  } catch {
    return {
      framework: "other",
      configFile: "package.json",
      quickRunCommand: "not detected",
      fullSuiteCommand: "not detected",
    };
  }
}

function readAuditUatOutput(cwd: string): AuditUatOutput | undefined {
  const toolPath = resolveGsdBundlePath("bin", "gsd-tools.cjs");
  try {
    const stdout = execFileSync(process.execPath, [toolPath, "audit-uat"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = JSON.parse(stdout) as unknown;
    if (!Value.Check(AuditUatOutputSchema, parsed)) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function buildValidationDraft(
  cwd: string,
  selection: NonNullable<ReturnType<typeof resolveValidatePhaseSelection>["selection"]>,
): string {
  const { framework, configFile, quickRunCommand, fullSuiteCommand } =
    detectValidationFramework(cwd);
  const phaseNumber = selection.phaseFilePrefix;
  const phaseSlug = normalizePhaseSlug(selection.phase.name);
  const created = new Date().toISOString().slice(0, 10);
  const fallbackRequirementValue =
    selection.phase.requirements.length > 0
      ? selection.phase.requirements.join(", ")
      : "Unmapped in ROADMAP.md";
  const snapshot = readPlanningSnapshot(cwd);
  const phaseSnapshot = snapshot.phases.find((phase) => phase.path === selection.phaseDir);
  const auditUat = readAuditUatOutput(cwd);
  const hasAutomatedRunner = quickRunCommand !== "not detected";
  const hasVerificationEvidence = (phaseSnapshot?.verifications.length ?? 0) > 0;
  const hasUatEvidence = (phaseSnapshot?.uats.length ?? 0) > 0;
  const taskRows = buildTaskRows(
    phaseSnapshot,
    selection,
    quickRunCommand,
    hasAutomatedRunner,
    hasVerificationEvidence,
    hasUatEvidence,
  );
  const waveZeroItems = hasAutomatedRunner
    ? ["Existing infrastructure covers all phase requirements."]
    : ["- [ ] Install or confirm test runner before claiming automated coverage"];
  const manualVerificationRows = buildManualVerificationRows(auditUat, selection);

  return [
    "---",
    `phase: ${phaseNumber}`,
    `slug: ${phaseSlug}`,
    "status: draft",
    "nyquist_compliant: false",
    "wave_0_complete: false",
    `created: ${created}`,
    "---",
    "",
    `# Phase ${phaseNumber} — Validation Strategy`,
    "",
    "> Per-phase validation contract for feedback sampling during execution.",
    "",
    "---",
    "",
    "## Test Infrastructure",
    "",
    "| Property               | Value         |",
    "| ---------------------- | ------------- |",
    `| **Framework**          | ${framework} |`,
    `| **Config file**        | ${configFile} |`,
    `| **Quick run command**  | \`${quickRunCommand}\` |`,
    `| **Full suite command** | \`${fullSuiteCommand}\` |`,
    "| **Estimated runtime**  | unknown |",
    "",
    "---",
    "",
    "## Sampling Rate",
    "",
    `- **After every task commit:** Run \`${quickRunCommand}\``,
    `- **After every plan wave:** Run \`${fullSuiteCommand}\``,
    "- **Before `/gsd verify-work`:** Full suite must be green",
    "- **Max feedback latency:** unknown",
    "",
    "---",
    "",
    "## Per-Task Verification Map",
    "",
    "| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |",
    "| ------- | ---- | ---- | ----------- | ---------- | --------------- | --------- | ----------------- | ----------- | ------ |",
    taskRows.length > 0
      ? taskRows
      : `| ${phaseNumber}-00 | -- | - | ${fallbackRequirementValue} | — | Pending workflow audit | unknown | \`${quickRunCommand}\` | ❌ | ⬜ pending |`,
    "",
    "_Status: COVERED · PARTIAL · MISSING_",
    "",
    "---",
    "",
    "## Wave 0 Requirements",
    "",
    ...waveZeroItems,
    "",
    '_If none: "Existing infrastructure covers all phase requirements."_',
    "",
    "---",
    "",
    "## Manual-Only Verifications",
    "",
    "| Behavior | Requirement | Why Manual | Test Instructions |",
    "| -------- | ----------- | ---------- | ----------------- |",
    manualVerificationRows.length > 0
      ? manualVerificationRows
      : "| None yet | — | Pending workflow audit | Populate only if automation is not credible |",
    "",
    '_If none: "All phase behaviors have automated verification."_',
    "",
    "---",
    "",
    "## Validation Sign-Off",
    "",
    "- [ ] All tasks have `<automated>` verify or Wave 0 dependencies",
    "- [ ] Sampling continuity: no 3 consecutive tasks without automated verify",
    "- [ ] Wave 0 covers all MISSING references",
    "- [ ] No watch-mode flags",
    "- [ ] Feedback latency captured",
    "- [ ] `nyquist_compliant: true` set in frontmatter",
    "",
    "**Approval:** pending",
    "",
  ].join("\n");
}

function ensureValidationDraft(
  cwd: string,
  selection: NonNullable<ReturnType<typeof resolveValidatePhaseSelection>["selection"]>,
): void {
  if (selection.validationTargetMode !== "create") {
    return;
  }

  const absoluteTargetPath = join(cwd, selection.validationTargetPath);
  if (existsSync(absoluteTargetPath)) {
    return;
  }

  const draft = buildValidationDraft(cwd, selection);
  writeFileSync(absoluteTargetPath, draft, "utf8");
}

export async function handleGsdValidatePhase(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: GsdCommandArgs,
  rawArgs: string,
): Promise<void> {
  if (args.unsupportedModeError !== undefined) {
    ctx.ui.notify(args.unsupportedModeError, "warning");
    return;
  }

  const resolved = resolveValidatePhaseSelection(ctx.cwd, args.phase);
  if (resolved.error !== undefined || resolved.selection === undefined) {
    ctx.ui.notify(resolved.error ?? "Cannot run /gsd validate-phase.", "warning");
    return;
  }

  ensureValidationDraft(ctx.cwd, resolved.selection);

  const commandArguments = stripValidatePhaseSubcommand(rawArgs) ?? resolved.selection.phase.number;
  await launchGsdWorkflowSession(pi, ctx, {
    commandName: "validate-phase",
    commandArguments,
    commandResourcePath: "commands/gsd/validate-phase.md",
    workflowResourcePaths: ["workflows/validate-phase.md"],
    extraResourcePaths: ["templates/VALIDATION.md", "references/gates.md"],
    extraInstructions: [
      "Use workflow-launch architecture for local `/gsd validate-phase` parity.",
      `Default omitted-phase target already resolved locally to phase ${resolved.selection.phase.number} using helper-ready roadmap-matching SUMMARY evidence.`,
      "Fail closed if bundled workflow discovers missing validation prerequisites or non-executed phase state.",
    ],
  });
}
