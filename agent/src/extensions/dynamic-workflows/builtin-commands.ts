/**
 * Bundled workflow commands: `/deep-research` and `/adversarial-review`. They run a generated
 * workflow script and print the final report.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "../../utils/error-message.js";
import { generateAdversarialReviewWorkflow } from "./adversarial-review.js";
import { generateDeepResearchWorkflow } from "./deep-research.js";
import { collectSimplifyChangeContext, generateSimplifyWorkflow } from "./simplify.js";
import type { WorkflowRunResult } from "./workflow.js";
import type { WorkflowManager } from "./workflow-manager.js";

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

export function registerBuiltinWorkflows(
  pi: ExtensionAPI,
  opts: { cwd: string; manager: WorkflowManager },
): void {
  const cwd = opts.cwd;
  const manager = opts.manager;

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
      handler(args: string, ctx: ExtensionCommandContext) {
        const question = args.trim();
        if (!question) {
          ctx.ui.notify("Usage: /deep-research <question>", "warning");
          return Promise.resolve();
        }
        startWorkflowCommandRun(pi, ctx, manager, {
          customType: "deep-research",
          script: generateDeepResearchWorkflow(),
          args: { question },
          toolNames: ["websearch"],
          startedMessage: "Researching in background — running web searches across several angles…",
          failurePrefix: "deep-research failed",
        });
        return Promise.resolve();
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
      handler(args: string, ctx: ExtensionCommandContext) {
        const task = args.trim();
        if (!task) {
          ctx.ui.notify("Usage: /adversarial-review <task or question>", "warning");
          return Promise.resolve();
        }
        startWorkflowCommandRun(pi, ctx, manager, {
          customType: "adversarial-review",
          script: generateAdversarialReviewWorkflow(),
          args: { task },
          startedMessage: "Reviewing in background — investigating then refuting each finding…",
          failurePrefix: "adversarial-review failed",
        });
        return Promise.resolve();
      },
    });
  }

  registerSimplifyWorkflow(pi, cwd, manager);
}

function registerSimplifyWorkflow(pi: ExtensionAPI, cwd: string, manager: WorkflowManager): void {
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
      try {
        const changeContext = await collectSimplifyChangeContext(cwd);
        startWorkflowCommandRun(pi, ctx, manager, {
          customType: "simplify",
          script: generateSimplifyWorkflow(),
          args: { ...changeContext, context: args.trim() },
          startedMessage:
            "Simplifying in background — reviewing changed code across reuse, quality, efficiency…",
          failurePrefix: "simplify failed",
        });
      } catch (error) {
        ctx.ui.notify(`simplify failed: ${errorMessage(error)}`, "error");
      }
    },
  });
}

function startWorkflowCommandRun(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  manager: WorkflowManager,
  options: {
    customType: string;
    script: string;
    args: unknown;
    toolNames?: string[];
    startedMessage: string;
    failurePrefix: string;
  },
): void {
  const { runId, promise } = manager.startInBackground(options.script, options.args, {
    displayName: options.customType,
    toolNames: options.toolNames,
  });
  ctx.ui.notify(`${options.startedMessage} Run ID: ${runId}`, "info");
  promise
    .then((result) => {
      pi.sendMessage({
        customType: options.customType,
        content: reportText(result),
        display: true,
      });
    })
    .catch((error: unknown) => {
      ctx.ui.notify(`${options.failurePrefix}: ${errorMessage(error)}`, "error");
    });
}
