import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import {
  BASE_BRANCH_PROMPT_FALLBACK,
  BASE_BRANCH_PROMPT_WITH_MERGE_BASE,
  COMMIT_PROMPT,
  COMMIT_PROMPT_WITH_TITLE,
  FOLDER_REVIEW_PROMPT,
  PULL_REQUEST_PROMPT,
  PULL_REQUEST_PROMPT_FALLBACK,
  UNCOMMITTED_PROMPT,
} from "./constants.js";
import { getMergeBase } from "./git.js";
import type { ReviewTarget } from "./types.js";

export async function buildReviewPrompt(pi: ExtensionAPI, target: ReviewTarget): Promise<string> {
  switch (target.type) {
    case "uncommitted":
      return UNCOMMITTED_PROMPT;
    case "baseBranch": {
      const mergeBase = await getMergeBase(pi, target.branch);
      return mergeBase !== null && mergeBase.length > 0
        ? BASE_BRANCH_PROMPT_WITH_MERGE_BASE.replaceAll("{baseBranch}", target.branch).replaceAll(
            "{mergeBaseSha}",
            mergeBase,
          )
        : BASE_BRANCH_PROMPT_FALLBACK.replaceAll("{branch}", target.branch);
    }
    case "commit":
      return target.title !== undefined && target.title.length > 0
        ? COMMIT_PROMPT_WITH_TITLE.replace("{sha}", target.sha).replace("{title}", target.title)
        : COMMIT_PROMPT.replace("{sha}", target.sha);
    case "pullRequest": {
      const mergeBase = await getMergeBase(pi, target.baseBranch);
      return mergeBase !== null && mergeBase.length > 0
        ? PULL_REQUEST_PROMPT.replaceAll("{prNumber}", String(target.prNumber))
            .replaceAll("{title}", target.title)
            .replaceAll("{baseBranch}", target.baseBranch)
            .replaceAll("{mergeBaseSha}", mergeBase)
        : PULL_REQUEST_PROMPT_FALLBACK.replaceAll("{prNumber}", String(target.prNumber))
            .replaceAll("{title}", target.title)
            .replaceAll("{baseBranch}", target.baseBranch);
    }
    case "folder":
      return FOLDER_REVIEW_PROMPT.replace("{paths}", target.paths.join(", "));
  }

  return UNCOMMITTED_PROMPT;
}

export function getUserFacingHint(target: ReviewTarget): string {
  switch (target.type) {
    case "uncommitted":
      return "current changes";
    case "baseBranch":
      return `changes against '${target.branch}'`;
    case "commit":
      return target.title !== undefined && target.title.length > 0
        ? `commit ${target.sha.slice(0, 7)}: ${target.title}`
        : `commit ${target.sha.slice(0, 7)}`;
    case "pullRequest":
      return `PR #${target.prNumber}: ${target.title.length > 30 ? `${target.title.slice(0, 27)}...` : target.title}`;
    case "folder": {
      const joined = target.paths.join(", ");
      return joined.length > 40 ? `folders: ${joined.slice(0, 37)}...` : `folders: ${joined}`;
    }
  }

  return "current changes";
}
