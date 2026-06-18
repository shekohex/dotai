import { generateBranchSummary, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "../utils/error-message.js";
import {
  DEFAULT_MODEL_FALLBACKS,
  isAbortSignalAborted,
  resolveModelFallbackAuth,
} from "./model-fallbacks.js";

const BRANCH_SUMMARY_TASK_LABEL = "Branch summary";

export default function branchSummaryExtension(pi: ExtensionAPI) {
  pi.on("session_before_tree", async (event, ctx) => {
    const preparation = event.preparation;
    if (!preparation.userWantsSummary || preparation.entriesToSummarize.length === 0) {
      return {};
    }

    ctx.ui.notify("Branch summary extension triggered", "info");

    for (const fallbackModel of DEFAULT_MODEL_FALLBACKS) {
      const modelAuth = await resolveModelFallbackAuth(
        ctx,
        fallbackModel,
        BRANCH_SUMMARY_TASK_LABEL,
      );
      if (!modelAuth) {
        continue;
      }

      ctx.ui.notify(
        `Branch summary: summarizing ${preparation.entriesToSummarize.length} entries with ${modelAuth.model.id}...`,
        "info",
      );

      try {
        const result = await generateBranchSummary(preparation.entriesToSummarize, {
          model: modelAuth.model,
          apiKey: modelAuth.apiKey,
          headers: modelAuth.headers,
          env: modelAuth.env,
          signal: event.signal,
          customInstructions: preparation.customInstructions,
          replaceInstructions: preparation.replaceInstructions,
        });

        if (result.aborted === true) {
          return { cancel: true };
        }
        if (result.error !== undefined && result.error.length > 0) {
          ctx.ui.notify(
            `Branch summary failed with ${modelAuth.model.id}: ${result.error}. Trying next fallback`,
            "error",
          );
          continue;
        }
        if (result.summary === undefined || result.summary.trim().length === 0) {
          if (!isAbortSignalAborted(event.signal)) {
            ctx.ui.notify(
              `Branch summary was empty for ${modelAuth.model.id}, trying next fallback`,
              "warning",
            );
          }
          continue;
        }

        return {
          summary: {
            summary: result.summary,
            details: {
              readFiles: result.readFiles ?? [],
              modifiedFiles: result.modifiedFiles ?? [],
            },
          },
        };
      } catch (error) {
        ctx.ui.notify(
          `Branch summary failed with ${modelAuth.model.id}: ${errorMessage(error)}. Trying next fallback`,
          "error",
        );
      }
    }

    if (!isAbortSignalAborted(event.signal)) {
      ctx.ui.notify(
        "Branch summary fallback list exhausted, using default branch summary",
        "warning",
      );
    }

    return {};
  });
}
