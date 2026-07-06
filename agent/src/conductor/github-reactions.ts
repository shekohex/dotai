import type { PullRequestFeedback } from "./github-feedback.js";
import { ADD_REACTION_MUTATION, REMOVE_REACTION_MUTATION } from "./github-queries.js";

const SEEN_REACTION_CONTENT = "EYES";
const HANDLED_REACTION_CONTENT = "THUMBS_UP";

export type GitHubGraphqlExec = (
  args: string[],
  cwd: string | undefined,
  label: string,
) => Promise<string>;

export async function markFeedbackSeenWithReaction(
  gh: GitHubGraphqlExec,
  feedback: PullRequestFeedback,
): Promise<void> {
  await addReaction(gh, feedback.reactionSubjectId, SEEN_REACTION_CONTENT);
}

export async function markFeedbackHandledWithReaction(
  gh: GitHubGraphqlExec,
  feedback: PullRequestFeedback,
): Promise<void> {
  await addReaction(gh, feedback.reactionSubjectId, HANDLED_REACTION_CONTENT);
  await tryRemoveReaction(gh, feedback.reactionSubjectId, SEEN_REACTION_CONTENT);
}

async function addReaction(
  gh: GitHubGraphqlExec,
  subjectId: string | undefined,
  content: string,
): Promise<void> {
  if (subjectId === undefined || subjectId.length === 0) return;
  await gh(reactionArgs(ADD_REACTION_MUTATION, subjectId, content), undefined, "gh reaction add");
}

async function tryRemoveReaction(
  gh: GitHubGraphqlExec,
  subjectId: string | undefined,
  content: string,
): Promise<void> {
  if (subjectId === undefined || subjectId.length === 0) return;
  try {
    await gh(
      reactionArgs(REMOVE_REACTION_MUTATION, subjectId, content),
      undefined,
      "gh reaction remove",
    );
  } catch {}
}

function reactionArgs(query: string, subjectId: string, content: string): string[] {
  return [
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-F",
    `subjectId=${subjectId}`,
    "-F",
    `content=${content}`,
  ];
}
