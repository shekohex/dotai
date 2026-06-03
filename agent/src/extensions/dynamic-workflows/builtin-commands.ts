/**
 * Bundled workflow commands: `/deep-research` and `/adversarial-review`. They run a generated
 * workflow script and print the final report.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "../../utils/error-message.js";
import { generateAdversarialReviewWorkflow } from "./adversarial-review.js";
import { generateDeepResearchWorkflow } from "./deep-research.js";
import { collectSimplifyChangeContext, generateSimplifyWorkflow } from "./simplify.js";
import { runWorkflow, type WorkflowRunResult } from "./workflow.js";

function alreadyRegistered(pi: ExtensionAPI, name: string): boolean {
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

export function registerBuiltinWorkflows(pi: ExtensionAPI, opts: { cwd: string }): void {
  const cwd = opts.cwd;

  if (!alreadyRegistered(pi, "deep-research")) {
    pi.registerCommand("deep-research", {
      description: "Research a question across the web with cross-checked sources",
      getArgumentCompletions(argumentPrefix) {
        return [
          {
            value: argumentPrefix,
            label: "<question>",
            description: "Question to research with websearch and cross-checking",
          },
        ];
      },
      async handler(args: string, ctx: ExtensionCommandContext) {
        const question = args.trim();
        if (!question) {
          ctx.ui.notify("Usage: /deep-research <question>", "warning");
          return;
        }
        ctx.ui.notify("Researching — running web searches across several angles…", "info");
        try {
          const result = await runWorkflow(generateDeepResearchWorkflow(), {
            cwd,
            pi,
            ctx,
            args: { question },
            toolNames: ["websearch"],
            onPhase: (title) => {
              ctx.ui.setStatus("deep-research", `research: ${title}`);
            },
          });
          ctx.ui.setStatus("deep-research", undefined);
          pi.sendMessage({
            customType: "deep-research",
            content: reportText(result),
            display: true,
          });
        } catch (error) {
          ctx.ui.setStatus("deep-research", undefined);
          ctx.ui.notify(`deep-research failed: ${errorMessage(error)}`, "error");
        }
      },
    });
  }

  if (!alreadyRegistered(pi, "adversarial-review")) {
    pi.registerCommand("adversarial-review", {
      description: "Investigate a task, then cross-check each finding with skeptical reviewers",
      getArgumentCompletions(argumentPrefix) {
        return [
          {
            value: argumentPrefix,
            label: "<task>",
            description: "Task or question to investigate and challenge",
          },
        ];
      },
      async handler(args: string, ctx: ExtensionCommandContext) {
        const task = args.trim();
        if (!task) {
          ctx.ui.notify("Usage: /adversarial-review <task or question>", "warning");
          return;
        }
        ctx.ui.notify("Reviewing — investigating then refuting each finding…", "info");
        try {
          const result = await runWorkflow(generateAdversarialReviewWorkflow(), {
            cwd,
            pi,
            ctx,
            args: { task },
            onPhase: (title) => {
              ctx.ui.setStatus("adversarial-review", `review: ${title}`);
            },
          });
          ctx.ui.setStatus("adversarial-review", undefined);
          pi.sendMessage({
            customType: "adversarial-review",
            content: reportText(result),
            display: true,
          });
        } catch (error) {
          ctx.ui.setStatus("adversarial-review", undefined);
          ctx.ui.notify(`adversarial-review failed: ${errorMessage(error)}`, "error");
        }
      },
    });
  }

  registerSimplifyWorkflow(pi, cwd);
}

function registerSimplifyWorkflow(pi: ExtensionAPI, cwd: string): void {
  if (alreadyRegistered(pi, "simplify")) return;
  pi.registerCommand("simplify", {
    description: "Review changed code for reuse, quality, and efficiency, then fix issues found",
    getArgumentCompletions(argumentPrefix) {
      return [
        {
          value: argumentPrefix,
          label: "[context]",
          description: "Optional fallback context when no git diff is available",
        },
      ];
    },
    async handler(args: string, ctx: ExtensionCommandContext) {
      ctx.ui.notify(
        "Simplifying — reviewing changed code across reuse, quality, efficiency…",
        "info",
      );
      try {
        const changeContext = await collectSimplifyChangeContext(cwd);
        const result = await runWorkflow(generateSimplifyWorkflow(), {
          cwd,
          pi,
          ctx,
          args: { ...changeContext, context: args.trim() },
          onPhase: (title) => {
            ctx.ui.setStatus("simplify", `simplify: ${title}`);
          },
        });
        ctx.ui.setStatus("simplify", undefined);
        pi.sendMessage({
          customType: "simplify",
          content: reportText(result),
          display: true,
        });
      } catch (error) {
        ctx.ui.setStatus("simplify", undefined);
        ctx.ui.notify(`simplify failed: ${errorMessage(error)}`, "error");
      }
    },
  });
}
