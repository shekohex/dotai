import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { GsdCommandArgs } from "../args.js";
import { handleGsdNext } from "../instant/next.js";
import { resolveGsdBundlePath } from "../resources.js";
import { launchGsdWorkflowSession } from "../workflow-launch.js";

const ProgressInitSchema = Type.Object(
  {
    project_exists: Type.Boolean(),
    roadmap_exists: Type.Boolean(),
    state_exists: Type.Boolean(),
    state_path: Type.String(),
    roadmap_path: Type.String(),
    project_path: Type.String(),
  },
  { additionalProperties: true },
);

let progressExecFileSync: typeof execFileSync = execFileSync;

export function setProgressExecFileSyncForTests(
  replacement: typeof execFileSync | undefined,
): void {
  progressExecFileSync = replacement ?? execFileSync;
}

function readProgressLaunchPrerequisites(cwd: string): { ok: true } | { ok: false; error: string } {
  const toolPath = resolveGsdBundlePath("bin", "gsd-tools.cjs");

  try {
    const stdout = progressExecFileSync(process.execPath, [toolPath, "init", "progress"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(stdout) as unknown;
    if (!Value.Check(ProgressInitSchema, parsed)) {
      return {
        ok: false,
        error: "Cannot run /gsd progress: helper returned invalid init progress payload.",
      };
    }
    if (!parsed.project_exists) {
      return {
        ok: false,
        error: `Cannot run /gsd progress: missing ${parsed.project_path}.`,
      };
    }
    if (!parsed.roadmap_exists) {
      return {
        ok: false,
        error: `Cannot run /gsd progress: missing ${parsed.roadmap_path}.`,
      };
    }
    if (!parsed.state_exists) {
      return {
        ok: false,
        error: `Cannot run /gsd progress: missing ${parsed.state_path}.`,
      };
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof Error) {
      return {
        ok: false,
        error: `Cannot run /gsd progress: ${error.message}.`,
      };
    }
    return {
      ok: false,
      error: "Cannot run /gsd progress: helper init failed.",
    };
  }
}

export async function handleGsdProgress(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: GsdCommandArgs = {},
): Promise<void> {
  if (args.unsupportedModeError !== undefined) {
    ctx.ui.notify(args.unsupportedModeError, "warning");
    return;
  }

  if (args.next === true) {
    await handleGsdNext(pi, ctx, args);
    return;
  }

  const prerequisites = readProgressLaunchPrerequisites(ctx.cwd);
  if (!prerequisites.ok) {
    ctx.ui.notify(prerequisites.error, "warning");
    return;
  }

  await launchGsdWorkflowSession(pi, ctx, {
    commandName: "progress",
    commandResourcePath: "commands/gsd/progress.md",
    workflowResourcePaths: ["workflows/progress.md"],
    extraInstructions: [
      "Use existing local bundled runtime helpers and query surface for progress inspection, milestone/phase resolution, and suggestions before making claims.",
      "Default local `/gsd progress` now routes through workflow-launch foundation instead of one-line TypeScript notify output.",
      "Preserve explicit unsupported handling for `--do` and `--forensic` unless those modes are genuinely implemented later.",
    ],
  });
}
