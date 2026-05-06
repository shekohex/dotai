import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { GsdCommandArgs } from "../args.js";
import { formatDetachedGsdFailure, runDetachedGsdJob } from "../detached-job.js";
import { resolvePlanningDir } from "../shared.js";
import { runRoleDetached } from "../subagents.js";
import { ensurePlanningDir } from "../state/write.js";
import { handleReadOnlyQueryMode } from "./map-codebase-query.js";
import {
  buildFastMapperTask,
  buildMapperTask,
  type CodebaseMapFocus,
  type FastCodebaseMapFocus,
} from "./map-codebase-prompts.js";
import {
  GSD_CODEBASE_MAP_SUMMARY_MESSAGE,
  type GsdCodebaseMapAreaSummary,
} from "../ui/messages.js";

const documentsByFocus: Record<CodebaseMapFocus, string[]> = {
  tech: ["STACK.md", "INTEGRATIONS.md"],
  arch: ["ARCHITECTURE.md", "STRUCTURE.md"],
  quality: ["CONVENTIONS.md", "TESTING.md"],
  concerns: ["CONCERNS.md"],
};

const codebaseDocumentNames = [
  "STACK.md",
  "INTEGRATIONS.md",
  "ARCHITECTURE.md",
  "STRUCTURE.md",
  "CONVENTIONS.md",
  "TESTING.md",
  "CONCERNS.md",
] as const;
const minimumArtifactBodyLines = 3;
const minimumArtifactBodyCharacters = 40;

const require = createRequire(import.meta.url);
const driftModule: unknown = require("../../../resources/gsd/bin/lib/drift.cjs");
const frontmatterPattern = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/u;

type WriteMappedCommit = (filePath: string, commitSha: string, isoDate?: string) => void;
type ReadMappedCommit = (filePath: string) => string | null;

function hasDriftHelpers(
  value: unknown,
): value is { writeMappedCommit: WriteMappedCommit; readMappedCommit: ReadMappedCommit } {
  return (
    typeof value === "object" &&
    value !== null &&
    "writeMappedCommit" in value &&
    typeof value.writeMappedCommit === "function" &&
    "readMappedCommit" in value &&
    typeof value.readMappedCommit === "function"
  );
}

function getDriftHelpers(): {
  writeMappedCommit: WriteMappedCommit;
  readMappedCommit: ReadMappedCommit;
} {
  if (hasDriftHelpers(driftModule)) {
    return driftModule;
  }

  throw new Error("GSD drift helper missing metadata helpers");
}

const { writeMappedCommit, readMappedCommit } = getDriftHelpers();

function resolveFastFocus(value: GsdCommandArgs["focus"]): FastCodebaseMapFocus {
  return value ?? "tech+arch";
}

function getDocumentsForFastFocus(focus: FastCodebaseMapFocus): string[] {
  if (focus === "tech+arch") {
    return [...documentsByFocus.tech, ...documentsByFocus.arch];
  }

  return documentsByFocus[focus];
}

function rejectUnsupportedModes(ctx: ExtensionCommandContext, args: GsdCommandArgs): boolean {
  if (args.unsupportedModeError !== undefined) {
    ctx.ui.notify(args.unsupportedModeError, "warning");
    return true;
  }

  if (args.focus !== undefined && args.fast !== true) {
    ctx.ui.notify(
      `Unsupported /gsd map-codebase mode: --focus ${args.focus} requires --fast upstream and is not implemented locally.`,
      "warning",
    );
    return true;
  }

  if (args.paths !== undefined) {
    ctx.ui.notify(
      "Unsupported /gsd map-codebase mode: --paths local scoped remap is not yet safe for canonical codebase docs. Run full `/gsd map-codebase`.",
      "warning",
    );
    return true;
  }

  return false;
}

function createCanonicalBackup(codebaseDir: string): string | null {
  const existingCanonicalDocs = codebaseDocumentNames.filter((name) =>
    existsSync(join(codebaseDir, name)),
  );
  if (existingCanonicalDocs.length === 0) {
    return null;
  }

  const backupDir = mkdtempSync(join(tmpdir(), "agent-gsd-map-codebase-backup-"));
  for (const name of existingCanonicalDocs) {
    copyFileSync(join(codebaseDir, name), join(backupDir, name));
  }
  return backupDir;
}

function createTargetedBackup(
  codebaseDir: string,
  documentNames: readonly string[],
): string | null {
  const existingTargetDocs = documentNames.filter((name) => existsSync(join(codebaseDir, name)));
  if (existingTargetDocs.length === 0) {
    return null;
  }

  const backupDir = mkdtempSync(join(tmpdir(), "agent-gsd-map-codebase-fast-backup-"));
  for (const name of existingTargetDocs) {
    copyFileSync(join(codebaseDir, name), join(backupDir, name));
  }
  return backupDir;
}

function isCanonicalCodebaseDocument(
  entry: string,
): entry is (typeof codebaseDocumentNames)[number] {
  return codebaseDocumentNames.some((name) => name === entry);
}

function restoreCanonicalBackup(codebaseDir: string, backupDir: string | null): void {
  if (backupDir === null) {
    for (const name of codebaseDocumentNames) {
      rmSync(join(codebaseDir, name), { force: true });
    }
    return;
  }

  if (!existsSync(backupDir)) {
    return;
  }

  for (const name of codebaseDocumentNames) {
    rmSync(join(codebaseDir, name), { force: true });
    if (existsSync(join(backupDir, name))) {
      copyFileSync(join(backupDir, name), join(codebaseDir, name));
    }
  }
}

function restoreTargetedBackup(
  codebaseDir: string,
  backupDir: string | null,
  documentNames: readonly string[],
): void {
  if (backupDir === null) {
    for (const name of documentNames) {
      rmSync(join(codebaseDir, name), { force: true });
    }
    return;
  }

  if (!existsSync(backupDir)) {
    return;
  }

  for (const name of documentNames) {
    rmSync(join(codebaseDir, name), { force: true });
    if (existsSync(join(backupDir, name))) {
      copyFileSync(join(backupDir, name), join(codebaseDir, name));
    }
  }
}

function removeCanonicalBackup(backupDir: string | null): void {
  if (backupDir !== null) {
    rmSync(backupDir, { recursive: true, force: true });
  }
}

function listExistingCodebaseDocuments(codebaseDir: string): string[] {
  if (!existsSync(codebaseDir)) {
    return [];
  }

  return readdirSync(codebaseDir)
    .filter((entry) => isCanonicalCodebaseDocument(entry))
    .toSorted();
}

function hasSubstantiveArtifactBody(content: string): boolean {
  const body = content.replace(frontmatterPattern, "").trim();
  if (body.length < minimumArtifactBodyCharacters) {
    return false;
  }

  const substantiveLines = body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return substantiveLines.length >= minimumArtifactBodyLines;
}

function isValidExistingCodebaseMap(codebaseDir: string): boolean {
  try {
    verifyCodebaseArtifacts(codebaseDir);
    return true;
  } catch {
    return false;
  }
}

function hasMappedCommitMetadata(codebaseDir: string): boolean {
  return codebaseDocumentNames.every((name) => readMappedCommit(join(codebaseDir, name)) !== null);
}

function readMappedCommitBaseline(codebaseDir: string): string | null {
  const baselines = new Set<string>();
  for (const name of codebaseDocumentNames) {
    const commitSha = readMappedCommit(join(codebaseDir, name));
    if (commitSha === null) {
      return null;
    }
    baselines.add(commitSha);
  }

  if (baselines.size !== 1) {
    return null;
  }

  const baseline = baselines.values().next().value;
  return typeof baseline === "string" ? baseline : null;
}

function isReusableBaselineCommit(cwd: string, commitSha: string): boolean {
  try {
    const objectType = execFileSync("git", ["cat-file", "-t", commitSha], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (objectType !== "commit") {
      return false;
    }

    execFileSync("git", ["merge-base", "--is-ancestor", commitSha, "HEAD"], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function hasReusableMappedCommitBaseline(cwd: string, codebaseDir: string): boolean {
  const baseline = readMappedCommitBaseline(codebaseDir);
  return baseline !== null && isReusableBaselineCommit(cwd, baseline);
}

function ensureSafeExistingDocsFlow(
  ctx: ExtensionCommandContext,
  codebaseDir: string,
  existingMode: GsdCommandArgs["existingMode"],
  allowRefreshDelete: boolean,
): boolean {
  const existingDocuments = listExistingCodebaseDocuments(codebaseDir);
  if (existingMode === "skip" && existingDocuments.length === 0) {
    ctx.ui.notify(
      "No canonical `.planning/codebase/` map exists yet. `skip` unavailable. Run `/gsd map-codebase` or `/gsd map-codebase update`.",
      "warning",
    );
    return true;
  }
  if (existingDocuments.length === 0) {
    return false;
  }

  const hasValidMap = isValidExistingCodebaseMap(codebaseDir);
  const hasReusableBaseline = hasReusableMappedCommitBaseline(ctx.cwd, codebaseDir);

  if (existingMode === "skip") {
    if (!hasValidMap) {
      ctx.ui.notify(
        "Existing `.planning/codebase/` docs are incomplete or invalid. `skip` unavailable. Use `/gsd map-codebase refresh` or `/gsd map-codebase update`.",
        "warning",
      );
      return true;
    }

    if (!hasMappedCommitMetadata(codebaseDir)) {
      ctx.ui.notify(
        "Existing `.planning/codebase/` docs are missing last_mapped_commit metadata. `skip` unavailable. Use `/gsd map-codebase refresh` or `/gsd map-codebase update`.",
        "warning",
      );
      return true;
    }

    if (!hasReusableBaseline) {
      ctx.ui.notify(
        "Existing `.planning/codebase/` docs do not share one valid reachable last_mapped_commit baseline. `skip` unavailable. Use `/gsd map-codebase refresh` or `/gsd map-codebase update`.",
        "warning",
      );
      return true;
    }

    ctx.ui.notify(`Using existing codebase map: ${codebaseDir}`, "info");
    return true;
  }

  if (existingMode === undefined) {
    ctx.ui.notify(
      [
        `.planning/codebase already exists: ${existingDocuments.join(", ")}`,
        hasValidMap && hasReusableBaseline
          ? "Choose next step: `/gsd map-codebase refresh`, `/gsd map-codebase update` (full in-place refresh), or `/gsd map-codebase skip`."
          : "Choose next step: `/gsd map-codebase refresh` or `/gsd map-codebase update`. `skip` unavailable until full codebase map exists.",
      ].join(" "),
      "warning",
    );
    return true;
  }

  if (existingMode === "refresh") {
    if (!allowRefreshDelete) {
      return false;
    }
    for (const name of codebaseDocumentNames) {
      rmSync(join(codebaseDir, name), { force: true });
    }
  }

  if (existingMode === "update") {
    for (const name of codebaseDocumentNames) {
      rmSync(join(codebaseDir, name), { force: true });
    }
    ctx.ui.notify("Local `/gsd map-codebase update` refreshes full codebase map in place.", "info");
  }

  return false;
}

function resolveHeadCommit(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function verifyCodebaseArtifacts(codebaseDir: string): Array<{ name: string; lines: number }> {
  return verifyExpectedCodebaseArtifacts(codebaseDir, codebaseDocumentNames);
}

function verifyExpectedCodebaseArtifacts(
  codebaseDir: string,
  documentNames: readonly string[],
): Array<{ name: string; lines: number }> {
  return documentNames.map((name) => {
    const path = join(codebaseDir, name);
    if (!existsSync(path)) {
      throw new Error(`Missing codebase map artifact: ${name}`);
    }

    if (!statSync(path).isFile()) {
      throw new Error(`Invalid codebase map artifact: ${name}`);
    }

    const content = readFileSync(path, "utf8");
    if (content.trim().length === 0) {
      throw new Error(`Empty codebase map artifact: ${name}`);
    }
    if (!hasSubstantiveArtifactBody(content)) {
      throw new Error(`Invalid codebase map artifact body: ${name}`);
    }

    return { name, lines: content.split(/\r?\n/u).length };
  });
}

function stampCodebaseArtifacts(
  codebaseDir: string,
  commitSha: string | null,
  isoDate: string,
): void {
  if (commitSha === null || commitSha.length === 0) {
    return;
  }

  for (const name of codebaseDocumentNames) {
    writeMappedCommit(join(codebaseDir, name), commitSha, isoDate);
  }
}

function stampExpectedCodebaseArtifacts(
  codebaseDir: string,
  documentNames: readonly string[],
  commitSha: string | null,
  isoDate: string,
): void {
  if (commitSha === null || commitSha.length === 0) {
    return;
  }

  for (const name of documentNames) {
    writeMappedCommit(join(codebaseDir, name), commitSha, isoDate);
  }
}

function ensureSafeFastExistingDocsFlow(
  ctx: ExtensionCommandContext,
  codebaseDir: string,
  existingMode: GsdCommandArgs["existingMode"],
  targetDocuments: readonly string[],
): boolean {
  if (existingMode === "update") {
    ctx.ui.notify(
      "Unsupported /gsd map-codebase mode: `--fast update` is not allowed locally. Use `/gsd map-codebase --fast refresh` or full `/gsd map-codebase update`.",
      "warning",
    );
    return true;
  }

  if (existingMode === "skip") {
    ctx.ui.notify(
      "Unsupported /gsd map-codebase mode: `--fast skip` is not allowed locally. Use `/gsd map-codebase skip` only for canonical full maps.",
      "warning",
    );
    return true;
  }

  const existingTargets = targetDocuments.filter((name) => existsSync(join(codebaseDir, name)));
  if (existingTargets.length === 0) {
    return false;
  }

  if (existingMode === undefined) {
    ctx.ui.notify(
      `Fast map would overwrite existing target docs: ${existingTargets.join(", ")}. Re-run with \`/gsd map-codebase --fast refresh\` to replace only fast-scan target docs.`,
      "warning",
    );
    return true;
  }

  for (const name of targetDocuments) {
    rmSync(join(codebaseDir, name), { force: true });
  }

  return false;
}

function handleFastCodebaseMap(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  codebaseDir: string,
  date: string,
  args: GsdCommandArgs,
): void {
  const focus = resolveFastFocus(args.focus);
  const targetDocuments = getDocumentsForFastFocus(focus);
  const backupDir = createTargetedBackup(codebaseDir, targetDocuments);

  if (ensureSafeFastExistingDocsFlow(ctx, codebaseDir, args.existingMode, targetDocuments)) {
    removeCanonicalBackup(backupDir);
    return;
  }

  runDetachedGsdJob(
    pi,
    ctx,
    async () => {
      const startedRole = await runRoleDetached(
        pi,
        ctx,
        "codebase-mapper",
        buildFastMapperTask(focus, date, ctx.cwd),
        {
          completion: false,
          name: `codebase-mapper:${focus}`,
        },
      );

      const terminalState = await startedRole.waitForResult();
      const areaSummaries: GsdCodebaseMapAreaSummary[] =
        focus === "tech+arch"
          ? [
              {
                focus: "tech",
                documents: documentsByFocus.tech,
                summary: terminalState.summary,
                capturedOutput: terminalState.capturedOutput,
                sessionId: terminalState.sessionId,
              },
              {
                focus: "arch",
                documents: documentsByFocus.arch,
                summary: terminalState.summary,
                capturedOutput: terminalState.capturedOutput,
                sessionId: terminalState.sessionId,
              },
            ]
          : [
              {
                focus,
                documents: documentsByFocus[focus],
                summary: terminalState.summary,
                capturedOutput: terminalState.capturedOutput,
                sessionId: terminalState.sessionId,
              },
            ];

      const artifacts = verifyExpectedCodebaseArtifacts(codebaseDir, targetDocuments);
      const commitSha = resolveHeadCommit(ctx.cwd);
      stampExpectedCodebaseArtifacts(
        codebaseDir,
        targetDocuments,
        commitSha,
        new Date().toISOString(),
      );

      return { areas: areaSummaries, artifacts, commitSha, focus };
    },
    {
      startMessage: `Started fast codebase map: 1 subagent (${focus})`,
      successMessage: ({ commitSha, focus: fastFocus }) =>
        commitSha === null
          ? `Fast codebase map updated without git baseline: ${codebaseDir} (${fastFocus})`
          : `Fast codebase map updated: ${codebaseDir} (${fastFocus})`,
      failureMessage: (error) => formatDetachedGsdFailure("Fast codebase map failed", error),
      onFailure: () => {
        restoreTargetedBackup(codebaseDir, backupDir, targetDocuments);
        removeCanonicalBackup(backupDir);
      },
      onSuccess: ({ areas, artifacts, commitSha, focus: fastFocus }) => {
        removeCanonicalBackup(backupDir);
        if (commitSha === null) {
          ctx.ui.notify(
            "Fast codebase map created without last_mapped_commit baseline. Fast scans are partial and cannot be reused for canonical `skip` or drift baseline decisions.",
            "warning",
          );
        }
        pi.sendMessage(
          {
            customType: GSD_CODEBASE_MAP_SUMMARY_MESSAGE,
            content: [
              "Fast codebase mapping complete.",
              "",
              `Focus: ${fastFocus} (partial, non-canonical)`,
              "Verified `.planning/codebase/` artifacts:",
              ...artifacts.map((artifact) => `- ${artifact.name} (${artifact.lines} lines)`),
              ...(commitSha === null
                ? ["- no last_mapped_commit baseline available"]
                : [`- stamped last_mapped_commit on fast-scan docs: ${commitSha}`]),
            ].join("\n"),
            display: true,
            details: {
              codebaseDir,
              areas,
            },
          },
          { deliverAs: "steer", triggerTurn: false },
        );
      },
    },
  );
}

function handleFullCodebaseMap(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  codebaseDir: string,
  date: string,
  existingMode: GsdCommandArgs["existingMode"],
): void {
  const scopedPaths: string[] = [];
  const backupDir = createCanonicalBackup(codebaseDir);

  if (ensureSafeExistingDocsFlow(ctx, codebaseDir, existingMode, true)) {
    removeCanonicalBackup(backupDir);
    return;
  }
  const focusAreas: CodebaseMapFocus[] = ["tech", "arch", "quality", "concerns"];

  runDetachedGsdJob(
    pi,
    ctx,
    async () => {
      const startedRoles = await Promise.all(
        focusAreas.map((focus) =>
          runRoleDetached(
            pi,
            ctx,
            "codebase-mapper",
            buildMapperTask(focus, date, scopedPaths, ctx.cwd),
            {
              completion: false,
              name: `codebase-mapper:${focus}`,
            },
          ),
        ),
      );

      const results = await Promise.all(
        startedRoles.map(async (startedRole, index) => {
          const terminalState = await startedRole.waitForResult();
          return {
            focus: focusAreas[index],
            documents: documentsByFocus[focusAreas[index]],
            summary: terminalState.summary,
            capturedOutput: terminalState.capturedOutput,
            sessionId: terminalState.sessionId,
          } satisfies GsdCodebaseMapAreaSummary;
        }),
      );

      const artifacts = verifyCodebaseArtifacts(codebaseDir);
      const commitSha = resolveHeadCommit(ctx.cwd);
      stampCodebaseArtifacts(codebaseDir, commitSha, new Date().toISOString());

      return { areas: results, artifacts, commitSha };
    },
    {
      startMessage: `Started codebase map: ${focusAreas.length} subagents`,
      successMessage: ({ commitSha }) =>
        commitSha === null
          ? `Codebase map updated without git baseline: ${codebaseDir}`
          : `Codebase map updated: ${codebaseDir}`,
      failureMessage: (error) => formatDetachedGsdFailure("Codebase map failed", error),
      onFailure: () => {
        restoreCanonicalBackup(codebaseDir, backupDir);
        removeCanonicalBackup(backupDir);
      },
      onSuccess: ({ areas, artifacts, commitSha }) => {
        removeCanonicalBackup(backupDir);
        if (commitSha === null) {
          ctx.ui.notify(
            "Codebase map created without last_mapped_commit baseline. Re-run inside git history before relying on `skip` or drift reuse.",
            "warning",
          );
        }
        pi.sendMessage(
          {
            customType: GSD_CODEBASE_MAP_SUMMARY_MESSAGE,
            content: [
              "Codebase mapping complete.",
              "",
              "Verified `.planning/codebase/` artifacts:",
              ...artifacts.map((artifact) => `- ${artifact.name} (${artifact.lines} lines)`),
              ...(commitSha === null
                ? ["- no last_mapped_commit baseline available"]
                : [`- stamped last_mapped_commit: ${commitSha}`]),
            ].join("\n"),
            display: true,
            details: {
              codebaseDir,
              areas,
            },
          },
          { deliverAs: "steer", triggerTurn: false },
        );
      },
    },
  );
}

export function handleGsdMapCodebase(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: GsdCommandArgs = {},
): void {
  if (handleReadOnlyQueryMode(ctx, args)) {
    return;
  }

  if (rejectUnsupportedModes(ctx, args)) {
    return;
  }

  const date = new Date().toISOString().slice(0, 10);

  ensurePlanningDir(ctx.cwd);
  const codebaseDir = join(resolvePlanningDir(ctx.cwd), "codebase");
  mkdirSync(codebaseDir, { recursive: true });

  if (args.fast === true) {
    handleFastCodebaseMap(pi, ctx, codebaseDir, date, args);
    return;
  }

  handleFullCodebaseMap(pi, ctx, codebaseDir, date, args.existingMode);
}
