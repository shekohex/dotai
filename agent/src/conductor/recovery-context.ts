import type { GitHubClient } from "./github.js";
import type { RecoveryPromptFeedback } from "./prompt.js";
import type { ConductorStore, RunRecord } from "./store/types.js";

export async function buildRecoveryPromptContext(input: {
  github: GitHubClient;
  run: RunRecord;
  store: ConductorStore;
}): Promise<{
  run: RunRecord;
  feedback: RecoveryPromptFeedback[];
  events: Array<{ kind: string; createdAt: string }>;
}> {
  return {
    run: input.run,
    feedback: await readRecoveryFeedback(input.github, input.run),
    events: (await input.store.listEvents(input.run.runId, 10)).map((event) => ({
      kind: event.kind,
      createdAt: event.createdAt,
    })),
  };
}

async function readRecoveryFeedback(
  github: GitHubClient,
  run: RunRecord,
): Promise<RecoveryPromptFeedback[]> {
  if (run.prNumber === undefined) return [];
  try {
    const login = await github.getAuthenticatedUser();
    return await github.listPullRequestFeedback(
      run.owner,
      run.repo,
      run.prNumber,
      run.issueNumber,
      [login],
    );
  } catch {
    return [];
  }
}
