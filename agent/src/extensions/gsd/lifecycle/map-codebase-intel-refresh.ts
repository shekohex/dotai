import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { formatDetachedGsdFailure, runDetachedGsdJob } from "../detached-job.js";
import { resolvePlanningDir } from "../shared.js";
import { runRoleDetached } from "../subagents.js";
import { GSD_INTEL_REFRESH_SUMMARY_MESSAGE } from "../ui/messages.js";
import { buildIntelRefreshTask } from "./map-codebase-prompts.js";

const require = createRequire(import.meta.url);
const intelModule: unknown = require("../../../resources/gsd/bin/lib/intel.cjs");

type IntelValidateResult =
  | { valid: boolean; errors: string[]; warnings: string[] }
  | { disabled: true; message: string };

const canonicalIntelArtifactNames = [
  "files.json",
  "apis.json",
  "deps.json",
  "arch.md",
  "stack.json",
] as const;
const readableIntelArtifactNames = [
  "files.json",
  "file-roles.json",
  "apis.json",
  "api-map.json",
  "deps.json",
  "dependency-graph.json",
  "arch.md",
  "arch.json",
  "arch-decisions.json",
  "stack.json",
] as const;
const readableIntelSnapshotNames = [".last-refresh.json", "snapshot.json"] as const;
const intelSnapshotFilename = ".last-refresh.json";
const legacyIntelArtifactNames = [
  "file-roles.json",
  "api-map.json",
  "dependency-graph.json",
  "arch.json",
  "arch-decisions.json",
] as const;
const legacyIntelSnapshotNames = ["snapshot.json"] as const;
const intelSuccessMarker = "## INTEL UPDATE COMPLETE";
const minimumArtifactBodyLines = 3;
const minimumArtifactBodyCharacters = 40;
const frontmatterPattern = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/u;

const IntelSnapshotSchema = Type.Object(
  {
    hashes: Type.Record(Type.String(), Type.String()),
    timestamp: Type.String(),
  },
  { additionalProperties: true },
);

const IntelMetaSchema = Type.Object(
  {
    updated_at: Type.String(),
    version: Type.Number(),
  },
  { additionalProperties: true },
);

const FilesIntelSchema = Type.Object(
  {
    _meta: IntelMetaSchema,
    entries: Type.Record(
      Type.String(),
      Type.Object(
        {
          exports: Type.Array(Type.String()),
          imports: Type.Array(Type.String()),
          type: Type.Union([
            Type.Literal("entry-point"),
            Type.Literal("module"),
            Type.Literal("config"),
            Type.Literal("test"),
            Type.Literal("script"),
            Type.Literal("type-def"),
            Type.Literal("style"),
            Type.Literal("template"),
            Type.Literal("data"),
          ]),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

const ApisIntelSchema = Type.Object(
  {
    _meta: IntelMetaSchema,
    entries: Type.Record(
      Type.String(),
      Type.Object(
        {
          method: Type.String(),
          path: Type.String(),
          params: Type.Array(Type.String()),
          file: Type.String(),
          description: Type.String(),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

const DepsIntelSchema = Type.Object(
  {
    _meta: IntelMetaSchema,
    entries: Type.Record(
      Type.String(),
      Type.Object(
        {
          version: Type.String(),
          type: Type.Union([
            Type.Literal("production"),
            Type.Literal("development"),
            Type.Literal("peer"),
            Type.Literal("optional"),
          ]),
          used_by: Type.Array(Type.String()),
          invocation: Type.String(),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

const StackIntelSchema = Type.Object(
  {
    _meta: IntelMetaSchema,
    languages: Type.Array(Type.String()),
    frameworks: Type.Array(Type.String()),
    tools: Type.Array(Type.String()),
    build_system: Type.String(),
    test_framework: Type.String(),
    package_manager: Type.String(),
    content_formats: Type.Array(Type.String()),
  },
  { additionalProperties: true },
);

function hasIntelHelpers(value: unknown): value is {
  intelValidate: (planningDir: string) => IntelValidateResult;
  isIntelEnabled: (planningDir: string) => boolean;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "intelValidate" in value &&
    typeof value.intelValidate === "function" &&
    "isIntelEnabled" in value &&
    typeof value.isIntelEnabled === "function"
  );
}

function getIntelHelpers(): {
  intelValidate: (planningDir: string) => IntelValidateResult;
  isIntelEnabled: (planningDir: string) => boolean;
} {
  if (hasIntelHelpers(intelModule)) {
    return intelModule;
  }

  throw new Error("GSD intel helper missing validate helper");
}

const { intelValidate, isIntelEnabled } = getIntelHelpers();

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

function verifyIntelArtifacts(intelDir: string): Array<{ name: string; lines: number }> {
  return canonicalIntelArtifactNames.map((name) => {
    const path = join(intelDir, name);
    if (!existsSync(path)) {
      throw new Error(`Missing intel artifact: ${name}`);
    }

    if (!statSync(path).isFile()) {
      throw new Error(`Invalid intel artifact: ${name}`);
    }

    const content = readFileSync(path, "utf8");
    if (content.trim().length === 0) {
      throw new Error(`Empty intel artifact: ${name}`);
    }
    if (!hasSubstantiveArtifactBody(content)) {
      throw new Error(`Invalid intel artifact body: ${name}`);
    }

    return { name, lines: content.split(/\r?\n/u).length };
  });
}

function parseIntelSnapshot(snapshotPath: string): {
  hashes: Record<string, string>;
  timestamp: string;
} {
  const parsed: unknown = JSON.parse(readFileSync(snapshotPath, "utf8"));
  if (!Value.Check(IntelSnapshotSchema, parsed)) {
    throw new Error(`Invalid intel snapshot artifact: ${intelSnapshotFilename}`);
  }
  return { hashes: parsed.hashes, timestamp: parsed.timestamp };
}

function parseCanonicalIntelJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
}

function verifyCanonicalIntelSchemas(intelDir: string): void {
  const filesJson = parseCanonicalIntelJson(join(intelDir, "files.json"));
  if (!Value.Check(FilesIntelSchema, filesJson)) {
    throw new Error("Invalid canonical intel schema: files.json");
  }

  const apisJson = parseCanonicalIntelJson(join(intelDir, "apis.json"));
  if (!Value.Check(ApisIntelSchema, apisJson)) {
    throw new Error("Invalid canonical intel schema: apis.json");
  }

  const depsJson = parseCanonicalIntelJson(join(intelDir, "deps.json"));
  if (!Value.Check(DepsIntelSchema, depsJson)) {
    throw new Error("Invalid canonical intel schema: deps.json");
  }

  const stackJson = parseCanonicalIntelJson(join(intelDir, "stack.json"));
  if (!Value.Check(StackIntelSchema, stackJson)) {
    throw new Error("Invalid canonical intel schema: stack.json");
  }
}

function hashFile(filePath: string): string | null {
  try {
    const content = readFileSync(filePath, "utf8");
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return null;
  }
}

function captureIntelRefreshState(cwd: string): {
  hashes: Record<string, string>;
  snapshotHash: string | null;
} {
  const planningDir = resolvePlanningDir(cwd);
  const intelDir = join(planningDir, "intel");
  const hashes = Object.fromEntries(
    canonicalIntelArtifactNames.flatMap((name) => {
      const hash = hashFile(join(intelDir, name));
      return hash === null ? [] : [[name, hash] as const];
    }),
  );
  return {
    hashes,
    snapshotHash: hashFile(join(intelDir, intelSnapshotFilename)),
  };
}

function createIntelBackup(cwd: string): string | null {
  const planningDir = resolvePlanningDir(cwd);
  const intelDir = join(planningDir, "intel");
  const existingArtifacts = [...readableIntelArtifactNames, ...readableIntelSnapshotNames].filter(
    (name) => existsSync(join(intelDir, name)),
  );
  if (existingArtifacts.length === 0) {
    return null;
  }

  const backupDir = mkdtempSync(join(tmpdir(), "agent-gsd-intel-refresh-backup-"));
  for (const name of existingArtifacts) {
    copyFileSync(join(intelDir, name), join(backupDir, name));
  }
  return backupDir;
}

function restoreIntelBackup(cwd: string, backupDir: string | null): void {
  const planningDir = resolvePlanningDir(cwd);
  const intelDir = join(planningDir, "intel");
  const managedArtifacts = [...readableIntelArtifactNames, ...readableIntelSnapshotNames];

  if (backupDir === null) {
    for (const name of managedArtifacts) {
      rmSync(join(intelDir, name), { force: true });
    }
    return;
  }

  if (!existsSync(backupDir)) {
    return;
  }

  for (const name of managedArtifacts) {
    rmSync(join(intelDir, name), { force: true });
    const backupPath = join(backupDir, name);
    if (existsSync(backupPath)) {
      copyFileSync(backupPath, join(intelDir, name));
    }
  }
}

function removeIntelBackup(backupDir: string | null): void {
  if (backupDir !== null) {
    rmSync(backupDir, { recursive: true, force: true });
  }
}

function removeLegacyIntelFallbacks(cwd: string): void {
  const planningDir = resolvePlanningDir(cwd);
  const intelDir = join(planningDir, "intel");
  for (const name of [...legacyIntelArtifactNames, ...legacyIntelSnapshotNames]) {
    rmSync(join(intelDir, name), { force: true });
  }
}

function verifyIntelRefreshOutputs(
  cwd: string,
  refreshStartedAtMs: number,
): Array<{ name: string; lines: number }> {
  const planningDir = resolvePlanningDir(cwd);
  const intelDir = join(planningDir, "intel");
  const artifacts = verifyIntelArtifacts(intelDir);
  verifyCanonicalIntelSchemas(intelDir);
  const currentState = captureIntelRefreshState(cwd);

  const validation = intelValidate(planningDir);
  if ("disabled" in validation) {
    throw new Error(validation.message);
  }
  if (!validation.valid) {
    throw new Error(`Intel validation failed: ${validation.errors.join("; ")}`);
  }
  const staleWarnings = validation.warnings.filter((warning) =>
    warning.includes("hours old (>24 hr)"),
  );
  if (staleWarnings.length > 0) {
    throw new Error(
      `Intel validation failed: stale outputs detected (${staleWarnings.join("; ")})`,
    );
  }

  const snapshotPath = join(intelDir, intelSnapshotFilename);
  if (!existsSync(snapshotPath)) {
    throw new Error(`Missing intel snapshot artifact: ${intelSnapshotFilename}`);
  }
  const snapshot = parseIntelSnapshot(snapshotPath);
  const snapshotTimestampMs = new Date(snapshot.timestamp).getTime();
  if (Number.isNaN(snapshotTimestampMs)) {
    throw new TypeError(`Invalid intel snapshot timestamp: ${intelSnapshotFilename}`);
  }
  if (snapshotTimestampMs < refreshStartedAtMs) {
    throw new Error("Intel snapshot timestamp predates this refresh invocation");
  }
  for (const name of canonicalIntelArtifactNames) {
    if (typeof snapshot.hashes[name] !== "string" || snapshot.hashes[name].length === 0) {
      throw new Error(`Intel snapshot missing hash for: ${name}`);
    }
    if (currentState.hashes[name] !== snapshot.hashes[name]) {
      throw new Error(`Intel snapshot hash mismatch for: ${name}`);
    }
  }

  return artifacts;
}

function hasIntelSuccessMarker(value: string | undefined): boolean {
  return value?.includes(intelSuccessMarker) ?? false;
}

export function handleIntelRefreshQuery(pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
  const planningDir = resolvePlanningDir(ctx.cwd);
  if (!isIntelEnabled(planningDir)) {
    ctx.ui.notify(
      "Intel system disabled. Set intel.enabled=true in config.json to activate.",
      "info",
    );
    return;
  }

  const backupDir = createIntelBackup(ctx.cwd);
  const refreshStartedAtMs = Date.now();

  runDetachedGsdJob(
    pi,
    ctx,
    async () => {
      const startedRole = await runRoleDetached(
        pi,
        ctx,
        "intel-updater",
        buildIntelRefreshTask(ctx.cwd),
        {
          completion: false,
          name: "intel-updater:full-refresh",
        },
      );

      const terminalState = await startedRole.waitForResult();
      if (
        !hasIntelSuccessMarker(terminalState.capturedOutput) &&
        !hasIntelSuccessMarker(terminalState.summary)
      ) {
        throw new Error("Intel updater finished without required completion marker");
      }

      return {
        artifacts: verifyIntelRefreshOutputs(ctx.cwd, refreshStartedAtMs),
        sessionId: terminalState.sessionId,
      };
    },
    {
      startMessage: "Started intel refresh: 1 subagent",
      successMessage: () => "Intel refresh updated: .planning/intel",
      failureMessage: (error) => formatDetachedGsdFailure("Intel refresh failed", error),
      onFailure: () => {
        restoreIntelBackup(ctx.cwd, backupDir);
        removeIntelBackup(backupDir);
      },
      onSuccess: ({ artifacts, sessionId }) => {
        removeLegacyIntelFallbacks(ctx.cwd);
        removeIntelBackup(backupDir);
        pi.sendMessage(
          {
            customType: GSD_INTEL_REFRESH_SUMMARY_MESSAGE,
            content: [
              "Intel refresh complete.",
              "",
              "Verified `.planning/intel/` artifacts:",
              ...artifacts.map((artifact) => `- ${artifact.name} (${artifact.lines} lines)`),
              `- ${intelSnapshotFilename}`,
            ].join("\n"),
            display: true,
            details: {
              intelDir: join(planningDir, "intel"),
              sessionId,
            },
          },
          { deliverAs: "steer", triggerTurn: false },
        );
      },
    },
  );
}
