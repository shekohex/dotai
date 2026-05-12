import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { GsdCommandArgs } from "../args.js";
import { resolveValidatePhaseSelection } from "../state/validate-phase.js";
import { readPlanningSnapshot } from "../state/read.js";
import { launchGsdWorkflowSession } from "../workflow-launch.js";

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
  const taskRows = selection.phase.plans
    .map((plan) => {
      const planFile = phaseSnapshot?.plans.find((entry) =>
        entry.fileName.startsWith(`${plan.id}-`),
      );
      let requirementValue = "Unmapped in ROADMAP.md";
      if (
        planFile?.frontmatter.requirements !== undefined &&
        planFile.frontmatter.requirements.length > 0
      ) {
        requirementValue = planFile.frontmatter.requirements.join(", ");
      } else if (selection.phase.requirements.length > 0) {
        requirementValue = selection.phase.requirements.join(", ");
      }
      const waveValue =
        planFile?.frontmatter.wave === undefined ? "-" : String(planFile.frontmatter.wave);
      const fileExists =
        phaseSnapshot?.summaries.includes(`${plan.id}-SUMMARY.md`) === true ? "✅" : "❌";
      return `| ${plan.id} | ${plan.id.split("-")[1] ?? "--"} | ${waveValue} | ${requirementValue} | — | Pending workflow audit | unknown | \`${quickRunCommand}\` | ${fileExists} | ⬜ pending |`;
    })
    .join("\n");

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
    "_Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky_",
    "",
    "---",
    "",
    "## Wave 0 Requirements",
    "",
    "- [ ] Detect missing automated tests during workflow audit",
    "- [ ] Map existing shared fixtures or helpers if needed",
    "- [ ] Install or confirm framework only if workflow audit proves missing",
    "",
    '_If none: "Existing infrastructure covers all phase requirements."_',
    "",
    "---",
    "",
    "## Manual-Only Verifications",
    "",
    "| Behavior | Requirement | Why Manual | Test Instructions |",
    "| -------- | ----------- | ---------- | ----------------- |",
    "| None yet | — | Pending workflow audit | Populate only if automation is not credible |",
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
