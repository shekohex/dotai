import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
  buildLaunchCommand,
  createDefaultMuxAdapter,
  createSubagentSDK,
} from "../../../subagent-sdk/index.js";
import type { SubagentHandle } from "../../../subagent-sdk/sdk-types.js";
import type { RuntimeSubagent, TSchemaBase } from "../../../subagent-sdk/types.js";
import { getReviewSettings } from "../../review/state.js";
import { buildReviewTaskPrompt } from "../../review/prompting.js";
import { buildReviewPrompt, getUserFacingHint } from "../../review/prompts.js";
import { loadProjectReviewGuidelines } from "../../review/guidelines.js";
import type { ReviewTarget } from "../../review/types.js";
import { buildAgentReviewUserMessage } from "../generated/agent-review-message.js";
import type { DiffType } from "../generated/review-core.js";
import type { PRMetadata } from "../generated/pr-provider.js";
import type { PRDiffScope } from "../generated/pr-stack.js";

const ReviewFindingSchema = Type.Object(
  {
    filePath: Type.String(),
    lineStart: Type.Integer({ minimum: 1 }),
    lineEnd: Type.Integer({ minimum: 1 }),
    side: Type.Optional(Type.Union([Type.Literal("old"), Type.Literal("new")])),
    title: Type.String(),
    text: Type.String(),
    kind: Type.Optional(
      Type.Union([
        Type.Literal("issue"),
        Type.Literal("nit"),
        Type.Literal("suggestion"),
        Type.Literal("question"),
      ]),
    ),
    severity: Type.Optional(Type.String()),
    reasoning: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ReviewStructuredResultSchema = Type.Object(
  {
    correctness: Type.String(),
    explanation: Type.String(),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    findings: Type.Array(ReviewFindingSchema),
  },
  { additionalProperties: false },
);

export type ReviewStructuredResult = Static<typeof ReviewStructuredResultSchema>;

type ReviewLaunchArgs = {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  cwd: string;
  currentPatch: string;
  currentDiffType: DiffType;
  currentBase: string;
  currentPrDiffScope: PRDiffScope;
  prMetadata?: PRMetadata;
};

function createReviewSubagentSdk(pi: ExtensionAPI) {
  return createSubagentSDK(pi, {
    adapter: createDefaultMuxAdapter(pi),
    buildLaunchCommand,
  });
}

export function startReviewModeSubagent(args: ReviewLaunchArgs): Promise<{
  sdk: ReturnType<typeof createReviewSubagentSdk>;
  state: RuntimeSubagent;
  prompt: string;
  handle: SubagentHandle;
}> {
  return (async () => {
    const sdk = createReviewSubagentSdk(args.pi);
    try {
      const task = await buildReviewTask(args);
      const started = await sdk.start(
        {
          name: "review",
          task,
          mode: "review",
          cwd: args.cwd,
          completion: false,
          outputFormat: {
            type: "json_schema",
            schema: ReviewStructuredResultSchema as TSchemaBase,
          },
        },
        args.ctx,
      );
      return {
        sdk,
        state: started.state,
        prompt: started.prompt,
        handle: started.handle,
      };
    } catch (error) {
      sdk.dispose();
      throw error;
    }
  })();
}

export function createFallbackPrompt(args: ReviewLaunchArgs): string {
  return buildAgentReviewUserMessage(
    args.currentPatch,
    args.currentDiffType,
    {
      defaultBranch: args.currentBase,
      hasLocalAccess: true,
      prDiffScope: args.currentPrDiffScope,
    },
    args.prMetadata,
  );
}

export function createReviewTarget(args: ReviewLaunchArgs): ReviewTarget | null {
  if (args.prMetadata !== undefined && args.currentPrDiffScope === "layer") {
    return {
      type: "pullRequest",
      prNumber:
        args.prMetadata.platform === "github" ? args.prMetadata.number : args.prMetadata.iid,
      baseBranch: args.prMetadata.baseBranch,
      title: args.prMetadata.title,
    };
  }
  if (args.currentDiffType === "uncommitted") {
    return { type: "uncommitted" };
  }
  if (
    args.currentDiffType === "branch" ||
    args.currentDiffType === "merge-base" ||
    args.currentDiffType === "jj-line"
  ) {
    return { type: "baseBranch", branch: args.currentBase };
  }
  return null;
}

export async function buildReviewTask(args: ReviewLaunchArgs): Promise<string> {
  const reviewTarget = createReviewTarget(args);
  const prompt =
    reviewTarget === null
      ? createFallbackPrompt(args)
      : await buildReviewPrompt(args.pi, reviewTarget);
  const targetLabel = reviewTarget === null ? "current changes" : getUserFacingHint(reviewTarget);
  const reviewSettings = getReviewSettings(args.ctx);
  const projectGuidelines = await loadProjectReviewGuidelines(args.cwd);
  return [
    buildReviewTaskPrompt({
      targetLabel,
      prompt,
      generatedHandoffPrompt: undefined,
      projectGuidelines,
      customInstructions: reviewSettings.customInstructions,
      extraInstruction: undefined,
    }),
    [
      "Return structured output with:",
      '- `correctness`: brief verdict like "Correct" or "Issues Found"',
      "- `explanation`: short overall explanation",
      "- `confidence`: number from 0 to 1",
      "- `findings`: array of conventional review comments using repository-relative `filePath`, 1-based `lineStart`/`lineEnd`, optional `side` (`old` for removed lines, `new` for added/current lines), required `title`, required `text`, optional `kind` (`issue`, `nit`, `suggestion`, `question`), optional `severity` (free-form string like `important`, `P1`, `high`, or `nit`), optional `reasoning`",
      "Include worthwhile nits and conventional review-style suggestions, not only hard bugs.",
      "Write each finding like a concise code review comment the author can act on immediately.",
      "Use an empty findings array if no issues are found.",
    ].join("\n"),
  ].join("\n\n");
}

export async function launchReviewModeSubagent(
  args: ReviewLaunchArgs,
): Promise<{ state: RuntimeSubagent; structured: ReviewStructuredResult }> {
  const sdk = createReviewSubagentSdk(args.pi);
  try {
    const task = await buildReviewTask(args);
    const outcome = await sdk.spawn(
      {
        name: "review",
        task,
        mode: "review",
        cwd: args.cwd,
        persisted: false,
        completion: false,
        outputFormat: { type: "json_schema", schema: ReviewStructuredResultSchema },
      },
      args.ctx,
    );
    if (!outcome.ok) {
      throw new Error(outcome.error.message);
    }
    return {
      state: outcome.value.state,
      structured: outcome.value.structured,
    };
  } finally {
    sdk.dispose();
  }
}
