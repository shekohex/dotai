/**
 * Saved workflows as `/<name>` slash commands. Each saved workflow becomes a command that runs its
 * script, passing parsed arguments through as `args`.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "../../utils/error-message.js";
import { runWorkflow, type WorkflowRunResult } from "./workflow.js";
import type { SavedWorkflow, WorkflowStorage } from "./workflow-saved.js";

function isRegistered(pi: ExtensionAPI, name: string): boolean {
  try {
    return (pi.getCommands?.() ?? []).some((c: { name: string }) => c.name === name);
  } catch {
    return false;
  }
}

function reportText(result: WorkflowRunResult): string {
  const r = result.result;
  if (hasStringReport(r)) return r.report;
  return JSON.stringify(result.result, null, 2);
}

function hasStringReport(value: unknown): value is { report: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "report" in value &&
    typeof value.report === "string" &&
    value.report.trim().length > 0
  );
}

/*
 * Parse a command argument string into an `args` object for the script. Supports `key=value`
 * tokens; everything else collects into `_` (and `_raw`). Declared parameter defaults fill in
 * missing keys.
 */
export function parseCommandArgs(
  raw: string,
  parameters?: SavedWorkflow["parameters"],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const positional: string[] = [];
  for (const tok of raw.trim().split(/\s+/).filter(Boolean)) {
    const eq = tok.indexOf("=");
    if (eq > 0) out[tok.slice(0, eq)] = tok.slice(eq + 1);
    else positional.push(tok);
  }
  out._ = positional.join(" ");
  out._raw = raw.trim();
  for (const [key, spec] of Object.entries(parameters ?? {})) {
    if (out[key] === undefined && spec.default !== undefined) out[key] = spec.default;
  }
  return out;
}

/* Register one saved workflow as a `/<name>` command (idempotent). */
export function registerSavedWorkflow(pi: ExtensionAPI, cwd: string, wf: SavedWorkflow): void {
  if (isRegistered(pi, wf.name)) return;
  pi.registerCommand(wf.name, {
    description: wf.description || `Saved workflow: ${wf.name}`,
    getArgumentCompletions(argumentPrefix) {
      const parameterItems = Object.entries(wf.parameters ?? {}).map(([name, spec]) => ({
        value: `${name}=`,
        label: `${name}=`,
        description: spec.description ?? `Set ${name}`,
      }));
      if (parameterItems.length === 0) {
        return [
          {
            value: argumentPrefix,
            label: "<args>",
            description: "Arguments exposed to workflow script as args._ and args._raw",
          },
        ];
      }
      const token = argumentPrefix.split(/\s+/).at(-1) ?? "";
      return parameterItems.filter((item) => item.value.startsWith(token));
    },
    async handler(args: string, ctx: ExtensionCommandContext) {
      try {
        const result = await runWorkflow(wf.script, {
          cwd,
          pi,
          ctx,
          args: parseCommandArgs(args, wf.parameters),
          onPhase: (title) => {
            ctx.ui.setStatus(`wf:${wf.name}`, `${wf.name}: ${title}`);
          },
        });
        ctx.ui.setStatus(`wf:${wf.name}`, undefined);
        pi.sendMessage({
          customType: `workflow:${wf.name}`,
          content: reportText(result),
          display: true,
        });
      } catch (error) {
        ctx.ui.setStatus(`wf:${wf.name}`, undefined);
        ctx.ui.notify(`/${wf.name} failed: ${errorMessage(error)}`, "error");
      }
    },
  });
}

/* Register every saved workflow found in storage. */
export function registerAllSavedWorkflows(
  pi: ExtensionAPI,
  cwd: string,
  storage: WorkflowStorage,
): void {
  for (const wf of storage.list()) registerSavedWorkflow(pi, cwd, wf);
}
